import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createStubDsh, type StubDsh } from 'stub-dsh';
import type { Gateway } from '../src/app.js';
import { json, startGateway } from './helpers.js';

/** 接缝 4：浏览器端到端（兑换 → 上传 → 出图 → 修改 → 确认）。
 *  需要先构建前端：npm run build -w frontend（缺失时跳过，`npm run e2e` 会先构建）。 */

const distDir = fileURLToPath(new URL('../../frontend/dist', import.meta.url));
const hasDist = existsSync(join(distDir, 'index.html'));

/** 合法 1×1 PNG（源图预览用） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const future = (): number => Date.now() + 60 * 60 * 1000;

describe.skipIf(!hasDist)('端到端：浏览器 × 网关 × stub', () => {
  let gw: Gateway;
  let stub: StubDsh;
  let browser: Browser;
  let page: Page;
  let dir: string;
  let pageErrors: string[];
  let consoleErrors: string[];

  beforeAll(async () => {
    stub = await createStubDsh({ delayMs: 30 });
    gw = await startGateway({
      dshBaseUrl: stub.baseUrl,
      dshApiKey: 'stub-secret',
      staticDir: distDir,
      stallTimeoutMs: 60_000,
    });
    dir = mkdtempSync(join(tmpdir(), 'dsh-e2e-'));
    writeFileSync(join(dir, 'a.png'), PNG);
    writeFileSync(join(dir, 'b.png'), PNG);

    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    pageErrors = [];
    consoleErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
    });
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await gw?.close();
    await stub?.close();
  });

  it('兑换 → 上传 → 出图 → 逐格修改 → 确认完成', async () => {
    const issued = await json<{ redeemCode: string; tokens: Array<{ token: string; taskId: string }> }>(
      `${gw.adminUrl}/admin/tokens`,
      'POST',
      { orderRef: 'ORD-E2E', tasks: [{ maxCells: 6 }], codeExpiresAt: future() },
    );
    expect(issued.status).toBe(200);
    const { redeemCode } = issued.data;

    /* 1. 兑换页：输入收货码 → 领取令牌 */
    await page.goto(gw.publicUrl);
    await page.fill('#redeem-code', redeemCode);
    await page.getByRole('button', { name: '兑换' }).click();
    await page.getByRole('link', { name: '进入工作台' }).click();

    /* 2. 工作台：WS 已连接 */
    await page.waitForSelector('.conn-open', { timeout: 15_000 });
    await expect
      .poll(() => page.evaluate(() => (document.querySelector('.topbar')?.textContent ?? '').includes('任务')))
      .toBe(true);

    /* 3. 上传两张源图 */
    await page.setInputFiles('input[type="file"]', [join(dir, 'a.png'), join(dir, 'b.png')]);
    await page.waitForSelector('.thumb-list li', { timeout: 15_000 });
    expect(await page.locator('.thumb-list li').count()).toBe(2);

    /* 4. 选 2 技能（单色海报 + 照片故事风格，均需源图）→ 预览 2×2=4 格 → 提交 */
    await page.getByRole('button', { name: /单色海报/ }).click();
    await page.getByRole('button', { name: /照片故事风格/ }).click();
    await page.fill('#param-title', '向北步行');
    await expect.poll(() => page.locator('.panel').filter({ hasText: '将生成 4 个出图单元' }).count()).toBe(1);
    await page.getByRole('button', { name: '开始生成' }).click();

    /* 5. 4 格逐格出图，落定到待确认 */
    await page.waitForFunction(() => document.querySelectorAll('.cell-card').length === 4, undefined, {
      timeout: 30_000,
    });
    await page.waitForFunction(
      () => {
        const btn = document.querySelector('.confirm-bar button.primary');
        return btn instanceof HTMLButtonElement && !btn.disabled;
      },
      undefined,
      { timeout: 30_000 },
    );
    expect(await page.locator('.cell-outputs img').count()).toBeGreaterThanOrEqual(4);

    /* 6. 逐格修改 cell_01 → 该格产出第二张 */
    const first = page.locator('.cell-card').first();
    await expect.poll(() => first.locator('.cell-id').textContent()).toBe('cell_01');
    await first.getByRole('button', { name: '修改' }).click();
    await first.locator('input[id="param-title"]').fill('标题改一版');
    await first.getByRole('button', { name: '发送修改' }).click();
    await page.waitForFunction(
      () => (document.querySelectorAll('.cell-card')[0]?.querySelectorAll('.cell-outputs img').length ?? 0) >= 2,
      undefined,
      { timeout: 30_000 },
    );

    /* 7. 整批确认 → done → 令牌从本地清除 */
    await page.getByRole('button', { name: /确认完成/ }).click();
    await page.getByText('任务已完成').waitFor({ timeout: 15_000 });
    expect(await page.evaluate(() => localStorage.getItem('dsh.tokens'))).toBe('[]');

    /* 8. 无 JS 异常、无控制台错误（忽略静态资源解码类噪声） */
    expect(pageErrors).toEqual([]);
    expect(consoleErrors.filter((t) => !t.includes('Failed to load resource'))).toEqual([]);
  }, 120_000);

  it('兑换页：未知收货码 → 中文错误提示', async () => {
    await page.goto(gw.publicUrl);
    await page.fill('#redeem-code', 'ZZZZZZZZ');
    await page.getByRole('button', { name: '兑换' }).click();
    await page.getByText('收货码不存在，请核对后重试').waitFor({ timeout: 10_000 });
  }, 30_000);
});
