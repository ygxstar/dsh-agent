import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpDshClient } from '../src/dsh-client.js';
import type { Gateway } from '../src/app.js';
import { createStubDsh, type StubDsh } from 'stub-dsh';
import { authedWs, json, startGateway, uploadImage, type WsClient } from './helpers.js';

/**
 * 接缝 3：dsh-client ↔ 真 stub-dsh（dsh-webapi 行为桩）。
 * 覆盖 SSE 消费、停滞超时、失败映射、文件往返，以及
 * 经网关全流程的产出差量登记与源图逐格分发。
 */

let stub: StubDsh;

beforeEach(async () => {
  stub = await createStubDsh({ apiKey: 'stub-secret' });
});

afterEach(async () => {
  await stub.close();
});

describe('HttpDshClient ↔ stub', () => {
  it('鉴权与元数据端点：skills 三技能、systemStatus ok、会话可创建', async () => {
    const client = new HttpDshClient(stub.baseUrl, 'stub-secret');
    const skills = await client.getSkills();
    expect(skills.map((s) => s.id)).toEqual(['mono-color', 'duo-poster', 'text-poster']);
    const status = await client.systemStatus();
    expect(status.status).toBe('ok');
    expect(await client.createSession()).toMatch(/^sess_/);

    const bad = new HttpDshClient(stub.baseUrl, 'wrong-key');
    await expect(bad.getSkills()).rejects.toMatchObject({ code: 'DSH_FAILED' });
  });

  it('SSE 正常流：逐段消费 delta，产出写入会话工作区', async () => {
    const client = new HttpDshClient(stub.baseUrl, 'stub-secret');
    const sid = await client.createSession();
    const deltas: string[] = [];
    await client.promptStream(sid, { prompt: JSON.stringify({ skill: 'mono-color', params: { title: '向北步行' } }), stallTimeoutMs: 5000 }, (d) => deltas.push(d));
    expect(deltas.length).toBe(3);
    expect(deltas[0]).toContain('mono-color');

    const files = await client.listFiles(sid);
    expect(files.some((f) => /^out-\d+\.png$/.test(f.path))).toBe(true);
  });

  it('HTTP 500（stub fail 模式）→ DSH_FAILED', async () => {
    stub.mode = 'fail';
    const client = new HttpDshClient(stub.baseUrl, 'stub-secret');
    const sid = await client.createSession();
    await expect(
      client.promptStream(sid, { prompt: '{"skill":"mono-color"}', stallTimeoutMs: 2000 }, () => {}),
    ).rejects.toMatchObject({ code: 'DSH_FAILED' });
  });

  it('握手后停滞（stub stall 模式）→ DSH_TIMEOUT（停滞看门）', async () => {
    stub.mode = 'stall';
    const client = new HttpDshClient(stub.baseUrl, 'stub-secret');
    const sid = await client.createSession();
    await expect(
      client.promptStream(sid, { prompt: '{"skill":"mono-color"}', stallTimeoutMs: 300 }, () => {}),
    ).rejects.toMatchObject({ code: 'DSH_TIMEOUT' });
  }, 10000);

  it('文件往返：upload → listFiles 含该文件 → download 字节一致', async () => {
    const client = new HttpDshClient(stub.baseUrl, 'stub-secret');
    const sid = await client.createSession();
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    const path = await client.uploadFile(sid, 'photo.png', bytes, 'image/png');
    expect(path).toBe('photo.png');
    const files = await client.listFiles(sid);
    expect(files.find((f) => f.path === path)).toMatchObject({ size: 5 });
    expect(await client.downloadFile(sid, path)).toEqual(bytes);
  });
});

describe('网关 × 真 stub：全流程（产出差量 + 源图分发）', () => {
  function waitSettled(c: WsClient, fromIndex = 0): Promise<{ cells: Array<{ cellId: string; outputs: string[] }> }> {
    return c.waitFor(
      (m) =>
        m.type === 'state' &&
        m.state === 'AWAITING_MODIFY_OR_CONFIRM' &&
        m.cells.every((s) => s.state !== 'CREATED' && s.state !== 'RUNNING'),
      10000,
      fromIndex,
    ) as Promise<{ cells: Array<{ cellId: string; outputs: string[] }> }>;
  }

  it('上传→首条→result（源图不被误登记为产出）→源图逐格复制→修改→确认→令牌作废', async () => {
    const client = new HttpDshClient(stub.baseUrl, 'stub-secret');
    const gw: Gateway = await startGateway(
      { dshBaseUrl: stub.baseUrl, dshApiKey: 'stub-secret', stallTimeoutMs: 5000 },
      client,
    );
    try {
      const issue = await json<{ tokens: Array<{ token: string; taskId: string }> }>(`${gw.adminUrl}/admin/tokens`, 'POST', {
        orderRef: 'ORD-E2E',
        tasks: [{}],
        codeExpiresAt: Date.now() + 3600_000,
      });
      const token = issue.data.tokens[0].token;

      // 上传源图（同名上传两次，staging 不得互相覆盖）
      const up1 = await uploadImage(`${gw.publicUrl}/upload`, token, new Uint8Array([137, 80, 78, 71, 1]));
      const up2 = await uploadImage(`${gw.publicUrl}/upload`, token, new Uint8Array([137, 80, 78, 71, 2]));
      expect(up1.status).toBe(200);
      expect(up2.status).toBe(200);
      expect(up1.data.imageRef).not.toBe(up2.data.imageRef);

      const c = await authedWs(gw.wsUrl, token);
      c.send({ type: 'command', skillIds: ['mono-color', 'text-poster'], imageRefs: [String(up1.data.imageRef)], params: { title: '向北步行' } });
      const settled = await waitSettled(c);

      // 2 格各有产出；每格 outputs 不含任何 img_* 源图引用
      expect(settled.cells).toHaveLength(2);
      for (const cell of settled.cells) {
        expect(cell.outputs.length).toBeGreaterThanOrEqual(1);
        expect(cell.outputs.every((o) => o.startsWith('out_'))).toBe(true);
      }

      // 源图分发：2 个格会话，且格会话内各有复制的源图文件
      expect(stub.sessionCount()).toBe(3); // staging + 2 格
      const results = c.received.filter((m) => m.type === 'result') as Array<{ imageRef: string }>;
      for (const r of results) {
        const file = await fetch(`${gw.publicUrl}/files/${r.imageRef}`);
        expect(file.status).toBe(200);
        expect(file.headers.get('content-type')).toBe('image/png');
        expect((await file.arrayBuffer()).byteLength).toBeGreaterThan(0);
      }

      // 修改产出图标题 → 同格重跑出新 result
      const mark = c.received.length;
      c.send({ type: 'command', cellId: 'cell_01', params: { title: '标题改一版' } });
      await c.waitFor((m) => m.type === 'result', 10000, mark);

      // 确认 → done，令牌作废
      c.send({ type: 'confirm', satisfaction: 5 });
      await c.waitFor((m) => m.type === 'done', 10000, mark);
      const auth = await json(`${gw.publicUrl}/auth`, 'POST', { token });
      expect(auth.status).toBe(401);
      expect(auth.data.error).toBe('TOKEN_USED');
      c.close();
    } finally {
      await gw.close();
    }
  });
});
