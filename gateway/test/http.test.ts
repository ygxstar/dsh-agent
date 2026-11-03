import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Gateway } from '../src/app.js';
import { FakeDsh } from './fake-dsh.js';
import { json, sleep, startGateway, uploadImage } from './helpers.js';

const HOUR = 60 * 60 * 1000;
const future = (): number => Date.now() + HOUR;

let gw: Gateway;
let dsh: FakeDsh;

async function issue(tasks: Array<Record<string, unknown>> = [{}], expiresAt = future()): Promise<{
  redeemCode: string;
  tokens: Array<{ token: string; taskId: string }>;
}> {
  const res = await json(`${gw.adminUrl}/admin/tokens`, 'POST', { orderRef: 'ORD-1', tasks, codeExpiresAt: expiresAt });
  expect(res.status).toBe(200);
  return res.data as { redeemCode: string; tokens: Array<{ token: string; taskId: string }> };
}

beforeEach(async () => {
  dsh = new FakeDsh();
  gw = await startGateway({}, dsh);
});

afterEach(async () => {
  await gw.close();
});

describe('管理 API：签发 / 列表 / 吊销', () => {
  it('签发返回收货码与令牌，令牌可 auth 出任务快照', async () => {
    const { redeemCode, tokens } = await issue();
    expect(redeemCode).toMatch(/^[0-9A-Z]{8}$/);
    expect(tokens).toHaveLength(1);

    const auth = await json(`${gw.publicUrl}/auth`, 'POST', { token: tokens[0].token });
    expect(auth.status).toBe(200);
    expect(auth.data).toMatchObject({ taskId: tokens[0].taskId, state: 'CREATED' });
    expect((auth.data.preset as { allowedSkillIds: string[] }).allowedSkillIds).toEqual(['mono-color', 'duo-poster', 'text-poster']);
  });

  it('codeExpiresAt 是过去时间 → BAD_PARAMS 400', async () => {
    const res = await json(`${gw.adminUrl}/admin/tokens`, 'POST', {
      orderRef: 'ORD-1',
      tasks: [{}],
      codeExpiresAt: Date.now() - 1000,
    });
    expect(res.status).toBe(400);
    expect(res.data.error).toBe('BAD_PARAMS');
  });

  it('吊销单个令牌 → auth 回 TOKEN_INVALID', async () => {
    const { tokens } = await issue();
    const rev = await json(`${gw.adminUrl}/admin/tokens/${encodeURIComponent(tokens[0].token)}`, 'DELETE');
    expect(rev.status).toBe(200);

    const auth = await json(`${gw.publicUrl}/auth`, 'POST', { token: tokens[0].token });
    expect(auth.status).toBe(401);
    expect(auth.data.error).toBe('TOKEN_INVALID');
  });

  it('吊销收货码 → 再领取回 REDEEM_REVOKED，未用令牌联动作废', async () => {
    const { redeemCode, tokens } = await issue();
    const revoke = await json(`${gw.adminUrl}/admin/codes/${redeemCode}/revoke`, 'POST');
    expect(revoke.status).toBe(200);
    expect(revoke.data.revokedTokens).toBe(1);

    const redeem = await json(`${gw.publicUrl}/redeem`, 'POST', { code: redeemCode });
    expect(redeem.status).toBe(401);
    expect(redeem.data.error).toBe('REDEEM_REVOKED');

    const auth = await json(`${gw.publicUrl}/auth`, 'POST', { token: tokens[0].token });
    expect(auth.status).toBe(401);
    expect(auth.data.error).toBe('TOKEN_INVALID');
  });
});

describe('兑换 /auth', () => {
  it('持收货码领取订单下全部令牌', async () => {
    const { redeemCode, tokens } = await issue([{}, { maxCells: 4 }, { maxCells: 6 }]);
    expect(tokens).toHaveLength(3);
    const res = await json<{ tokens: Array<{ token: string; taskId: string }> }>(`${gw.publicUrl}/redeem`, 'POST', {
      code: redeemCode,
    });
    expect(res.status).toBe(200);
    expect(res.data.tokens).toHaveLength(3);
    expect(res.data.tokens.map((t) => t.token).sort()).toEqual(tokens.map((t) => t.token).sort());
  });

  it('未知码 → REDEEM_INVALID 401', async () => {
    const res = await json(`${gw.publicUrl}/redeem`, 'POST', { code: 'ZZZZZZZZ' });
    expect(res.status).toBe(401);
    expect(res.data.error).toBe('REDEEM_INVALID');
  });

  it('码过期 → REDEEM_EXPIRED 401', async () => {
    const { redeemCode } = await issue([{}], Date.now() + 120);
    await sleep(200);
    const res = await json(`${gw.publicUrl}/redeem`, 'POST', { code: redeemCode });
    expect(res.status).toBe(401);
    expect(res.data.error).toBe('REDEEM_EXPIRED');
  });

  it('同码领取超过频控 → LIMIT 429（gateway-interface §4.3：领取限频归 LIMIT）', async () => {
    const { redeemCode } = await issue(); // redeemRateLimit 默认 10/min
    let last = { status: 0, data: {} as Record<string, unknown> };
    for (let i = 0; i < 11; i += 1) last = await json(`${gw.publicUrl}/redeem`, 'POST', { code: redeemCode });
    expect(last.status).toBe(429);
    expect(last.data.error).toBe('LIMIT');
  });

  it('缺 code → BAD_PARAMS 400', async () => {
    const res = await json(`${gw.publicUrl}/redeem`, 'POST', {});
    expect(res.status).toBe(400);
    expect(res.data.error).toBe('BAD_PARAMS');
  });

  it('缺失/未知令牌 → TOKEN_INVALID 401；USED → TOKEN_USED；EXPIRED → TOKEN_EXPIRED', async () => {
    const { tokens } = await issue();
    const token = tokens[0].token;

    expect((await json(`${gw.publicUrl}/auth`, 'POST', {})).data.error).toBe('TOKEN_INVALID');
    expect((await json(`${gw.publicUrl}/auth`, 'POST', { token: 'tk_nope' })).data.error).toBe('TOKEN_INVALID');

    gw.deps.tokens.get(token)!.state = 'USED';
    const used = await json(`${gw.publicUrl}/auth`, 'POST', { token });
    expect(used.status).toBe(401);
    expect(used.data.error).toBe('TOKEN_USED');

    gw.deps.tokens.get(token)!.state = 'EXPIRED';
    const expired = await json(`${gw.publicUrl}/auth`, 'POST', { token });
    expect(expired.status).toBe(401);
    expect(expired.data.error).toBe('TOKEN_EXPIRED');
  });
});

describe('GET /skills', () => {
  it('返回网关侧三技能清单', async () => {
    const res = await json<Array<{ id: string }>>(`${gw.publicUrl}/skills`, 'GET');
    expect(res.status).toBe(200);
    expect(res.data.map((s) => s.id)).toEqual(['mono-color', 'duo-poster', 'text-poster']);
  });
});

describe('POST /upload', () => {
  it('首条指令前上传成功返回 imageRef，可经 /files 下载原字节', async () => {
    const { tokens } = await issue();
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const up = await uploadImage(`${gw.publicUrl}/upload`, tokens[0].token, bytes);
    expect(up.status).toBe(200);
    const ref = String(up.data.imageRef);
    expect(ref).toMatch(/^img_/);

    const file = await fetch(`${gw.publicUrl}/files/${ref}`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
  });

  it('缺 Bearer → TOKEN_INVALID 401；未知令牌同样 401', async () => {
    const noAuth = await uploadImage(`${gw.publicUrl}/upload`, '', new Uint8Array([1]));
    expect(noAuth.status).toBe(401);
    expect(noAuth.data.error).toBe('TOKEN_INVALID');
    const bad = await uploadImage(`${gw.publicUrl}/upload`, 'tk_nope', new Uint8Array([1]));
    expect(bad.status).toBe(401);
  });

  it('首条指令提交后（expanded）再传 → STATE_INVALID 409', async () => {
    const { tokens } = await issue();
    gw.runtime.get(tokens[0].taskId)!.expanded = true;
    const up = await uploadImage(`${gw.publicUrl}/upload`, tokens[0].token, new Uint8Array([1]));
    expect(up.status).toBe(409);
    expect(up.data.error).toBe('STATE_INVALID');
  });

  it('非图片 MIME → BAD_PARAMS 400', async () => {
    const { tokens } = await issue();
    const up = await uploadImage(`${gw.publicUrl}/upload`, tokens[0].token, new Uint8Array([65]), 'a.txt', 'text/plain');
    expect(up.status).toBe(400);
    expect(up.data.error).toBe('BAD_PARAMS');
  });

  it('超过 maxUploadBytes → PAYLOAD_TOO_LARGE 413', async () => {
    await gw.close();
    dsh = new FakeDsh();
    gw = await startGateway({ maxUploadBytes: 1024 }, dsh);
    const { tokens } = await issue();
    const up = await uploadImage(`${gw.publicUrl}/upload`, tokens[0].token, new Uint8Array(2048));
    expect(up.status).toBe(413);
    expect(up.data.error).toBe('PAYLOAD_TOO_LARGE');
  });

  it('未知引用 /files/ref → IMAGE_REF_INVALID 409', async () => {
    const res = await fetch(`${gw.publicUrl}/files/img_missing`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('IMAGE_REF_INVALID');
  });
});

describe('静态托管', () => {
  it('未配置 staticDir → 404', async () => {
    const res = await fetch(`${gw.publicUrl}/`);
    expect(res.status).toBe(404);
  });

  it('配置 staticDir → 首页 200，无扩展路径回退 index.html（SPA），缺资源 404', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-static-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
    await gw.close();
    dsh = new FakeDsh();
    gw = await startGateway({ staticDir: dir }, dsh);
    try {
      const home = await fetch(`${gw.publicUrl}/`);
      expect(home.status).toBe(200);
      expect(await home.text()).toContain('app');

      const spa = await fetch(`${gw.publicUrl}/task/task_abc`);
      expect(spa.status).toBe(200);
      expect(await spa.text()).toContain('app');

      const missing = await fetch(`${gw.publicUrl}/assets/nope.js`);
      expect(missing.status).toBe(404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
