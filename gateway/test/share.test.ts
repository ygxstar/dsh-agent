import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Gateway } from '../src/app.js';
import type { Downlink, Preset } from '../src/types.js';
import { FakeDsh } from './fake-dsh.js';
import { authedWs, connectWs, json, sleep, startGateway, uploadImage, type WsClient } from './helpers.js';

const future = (): number => Date.now() + 60 * 60 * 1000;

let gw: Gateway;
let dsh: FakeDsh;

async function issue(tasks: Array<Record<string, unknown>> = [{}]): Promise<{
  redeemCode: string;
  tokens: Array<{ token: string; taskId: string }>;
}> {
  const res = await json(`${gw.adminUrl}/admin/tokens`, 'POST', { orderRef: 'ORD-1', tasks, codeExpiresAt: future() });
  expect(res.status).toBe(200);
  return res.data as { redeemCode: string; tokens: Array<{ token: string; taskId: string }> };
}

/** owner 全套：令牌 + 源图 + 已登录 WS + 已签发分享令牌 */
async function setup(taskOpts: Array<Record<string, unknown>> = [{}], imageCount = 1) {
  const { tokens } = await issue(taskOpts);
  const refs: string[] = [];
  for (let i = 0; i < imageCount; i += 1) {
    const up = await uploadImage(`${gw.publicUrl}/upload`, tokens[0].token, new Uint8Array([137, 80, 78, 71, i]));
    expect(up.status).toBe(200);
    refs.push(String(up.data.imageRef));
  }
  const owner = await authedWs(gw.wsUrl, tokens[0].token);
  const share = await json(`${gw.publicUrl}/task/${tokens[0].taskId}/share`, 'POST', undefined, {
    authorization: `Bearer ${tokens[0].token}`,
  });
  expect(share.status).toBe(200);
  return { token: tokens[0].token, taskId: tokens[0].taskId, refs, owner, sh: String(share.data.sh) };
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** viewer 连接 + 只读 auth（不等返回，便于断言具体下行） */
async function viewerWs(taskId: string, sh: string): Promise<WsClient> {
  const v = await connectWs(gw.wsUrl);
  v.send({ type: 'auth', role: 'viewer', token: sh, taskId });
  return v;
}

/** 等服务端主动关闭该连接；3s 未关闭即失败（避免挂到测试超时才报错） */
function waitServerClose(c: WsClient, label: string): Promise<void> {
  const closed = new Promise<void>((resolve) => c.ws.once('close', () => resolve()));
  return Promise.race([
    closed,
    sleep(3000).then(() => {
      throw new Error(label);
    }),
  ]);
}

/** 等任务落定为可修改/确认（所有格非 CREATED/RUNNING）；fromIndex 只看发指令后的新事件 */
function waitSettled(c: WsClient, fromIndex = 0): Promise<Downlink> {
  return c.waitFor(
    (m) =>
      m.type === 'state' &&
      m.state === 'AWAITING_MODIFY_OR_CONFIRM' &&
      m.cells.every((s) => s.state !== 'CREATED' && s.state !== 'RUNNING'),
    8000,
    fromIndex,
  );
}

beforeEach(async () => {
  dsh = new FakeDsh();
  gw = await startGateway({}, dsh);
});

afterEach(async () => {
  await gw.close();
});

describe('分享签发 / 轮换 / 撤销（owner 管理端点）', () => {
  it('POST 签发 sh_ 令牌，GET 回显；重复 POST 即轮换，旧 sh 下一次请求 403', async () => {
    const { token, taskId, sh } = await setup();
    expect(sh).toMatch(/^sh_[A-Za-z0-9_-]{20,}$/); // 与 tk_* 同构（随机 base64url）

    const status = await json<{ shared: boolean; sh: string }>(`${gw.publicUrl}/task/${taskId}/share`, 'GET', undefined, bearer(token));
    expect(status.status).toBe(200);
    expect(status.data).toMatchObject({ shared: true, sh });

    // 重新分享即轮换：新 token 可用，旧 token 立即 403
    const again = await json<{ sh: string }>(`${gw.publicUrl}/task/${taskId}/share`, 'POST', undefined, bearer(token));
    expect(again.status).toBe(200);
    const sh2 = again.data.sh;
    expect(sh2).not.toBe(sh);
    const oldRes = await json(`${gw.publicUrl}/auth`, 'POST', { sh, taskId });
    expect(oldRes.status).toBe(403);
    expect(oldRes.data.error).toBe('SHARE_INVALID');
    expect((await json(`${gw.publicUrl}/auth`, 'POST', { sh: sh2, taskId })).status).toBe(200);

    // 停止分享 → 链接下一次请求 403；状态回显未分享
    const del = await json(`${gw.publicUrl}/task/${taskId}/share`, 'DELETE', undefined, bearer(token));
    expect(del.status).toBe(200);
    expect(del.data).toMatchObject({ shared: false, revoked: true });
    const status2 = await json<{ shared: boolean }>(`${gw.publicUrl}/task/${taskId}/share`, 'GET', undefined, bearer(token));
    expect(status2.data.shared).toBe(false);
    const revokedRes = await json(`${gw.publicUrl}/auth`, 'POST', { sh: sh2, taskId });
    expect(revokedRes.status).toBe(403);
    expect(revokedRes.data.error).toBe('SHARE_INVALID');
  });

  it('管理端点鉴权：无 Bearer 401，sh_ Bearer 403，他人任务令牌 401', async () => {
    const { taskId, sh } = await setup();
    const noAuth = await json(`${gw.publicUrl}/task/${taskId}/share`, 'POST');
    expect(noAuth.status).toBe(401);

    const viaSh = await json(`${gw.publicUrl}/task/${taskId}/share`, 'POST', undefined, bearer(sh));
    expect(viaSh.status).toBe(403);
    expect(viaSh.data.error).toBe('SHARE_INVALID');

    const other = await issue(); // 第二个任务的令牌：跨任务管理分享
    const cross = await json(`${gw.publicUrl}/task/${taskId}/share`, 'POST', undefined, bearer(other.tokens[0].token));
    expect(cross.status).toBe(401);
    expect(cross.data.error).toBe('TOKEN_INVALID');
  });
});

describe('HTTP 只读通道（POST /auth 带 sh）', () => {
  it('有效 sh 返回与所有者一致的任务快照，不校验 tk_*', async () => {
    const { token, taskId, sh } = await setup();
    const ownerAuth = await json(`${gw.publicUrl}/auth`, 'POST', { token });
    const shareAuth = await json(`${gw.publicUrl}/auth`, 'POST', { sh, taskId });
    expect(shareAuth.status).toBe(200);
    expect(shareAuth.data).toMatchObject({ taskId, state: ownerAuth.data.state });
    expect(shareAuth.data.cells).toEqual(ownerAuth.data.cells);
    expect((shareAuth.data.preset as Preset).allowedSkillIds).toEqual((ownerAuth.data.preset as Preset).allowedSkillIds);
  });

  it('伪造 sh、缺 taskId、他人任务的 sh、撤销后 → 确定性 403 SHARE_INVALID', async () => {
    const { token, taskId, sh } = await setup();
    const forged = await json(`${gw.publicUrl}/auth`, 'POST', { sh: 'sh_forged-token', taskId });
    expect(forged.status).toBe(403);
    expect(forged.data.error).toBe('SHARE_INVALID');

    const noTaskId = await json(`${gw.publicUrl}/auth`, 'POST', { sh });
    expect(noTaskId.status).toBe(403);
    expect(noTaskId.data.error).toBe('SHARE_INVALID');

    const other = await issue(); // 他人任务：拿本任务的 sh 配别的 taskId
    const mismatch = await json(`${gw.publicUrl}/auth`, 'POST', { sh, taskId: other.tokens[0].taskId });
    expect(mismatch.status).toBe(403);
    expect(mismatch.data.error).toBe('SHARE_INVALID');

    await json(`${gw.publicUrl}/task/${taskId}/share`, 'DELETE', undefined, bearer(token));
    expect((await json(`${gw.publicUrl}/auth`, 'POST', { sh, taskId })).status).toBe(403);
  });

  it('任务过期后的 sh → 403，且分享条目随任务清理', async () => {
    const { taskId, sh } = await setup();
    gw.deps.runtime.get(taskId)!.state = 'EXPIRED';
    const res = await json(`${gw.publicUrl}/auth`, 'POST', { sh, taskId });
    expect(res.status).toBe(403);
    expect(res.data.error).toBe('SHARE_INVALID');
    expect(gw.deps.shares.getByTask(taskId)).toBeUndefined();
  });

  it('超过分享 TTL（24h，任务未过期也一样）→ 403 SHARE_INVALID 且条目即删', async () => {
    const { taskId, sh } = await setup();
    const entry = gw.deps.shares.getByTask(taskId)!;
    entry.createdAt -= gw.config.taskTtlMs; // 拨回签发时间模拟 24h 已过
    expect(gw.deps.runtime.get(taskId)!.state).not.toBe('EXPIRED'); // 任务本体仍有效，独立 TTL 生效
    const res = await json(`${gw.publicUrl}/auth`, 'POST', { sh, taskId });
    expect(res.status).toBe(403);
    expect(res.data.error).toBe('SHARE_INVALID');
    expect(gw.deps.shares.getByTask(taskId)).toBeUndefined(); // 过期即删条目
  });

  it('viewer 持 sh 调 HTTP 写端点 /upload → 403 SHARE_INVALID', async () => {
    const { sh } = await setup();
    const up = await uploadImage(`${gw.publicUrl}/upload`, sh, new Uint8Array([1, 2, 3]));
    expect(up.status).toBe(403);
    expect(up.data.error).toBe('SHARE_INVALID');
  });
});

describe('WS viewer 只读角色', () => {
  it('viewer auth 成功回 auth_ok，快照与所有者完全一致', async () => {
    const { taskId, sh, owner } = await setup();
    const v = await viewerWs(taskId, sh);
    const ok = await v.waitFor((m) => m.type === 'auth_ok');
    expect(ok).toMatchObject({ taskId, state: 'CREATED' });
    expect(JSON.stringify(ok)).toBe(JSON.stringify(owner.received[0]));
    v.close();
    owner.close();
  });

  it('viewer 收到与所有者相同的 state 推送（实时同步）', async () => {
    const { taskId, sh, refs, owner } = await setup([{}], 1);
    const v = await viewerWs(taskId, sh);
    await v.waitFor((m) => m.type === 'auth_ok');

    owner.send({ type: 'command', skillIds: ['mono-color'], imageRefs: refs, params: { title: '向北步行' } });
    const settledOwner = await waitSettled(owner, 1);
    const settledViewer = await waitSettled(v, 1);
    expect(settledViewer).toMatchObject({ state: 'AWAITING_MODIFY_OR_CONFIRM' });
    // 广播序列一致：双方除各自的 auth_ok 外收到同一串下行
    const strip = (c: WsClient): string => JSON.stringify(c.received.filter((m) => m.type !== 'auth_ok'));
    expect(strip(v)).toBe(strip(owner));
    expect(JSON.stringify(settledOwner)).toBe(JSON.stringify(settledViewer));
    v.close();
    owner.close();
  });

  it('viewer 的 command / confirm 直接以 READONLY 拒绝，任务状态不变', async () => {
    const { taskId, sh, refs, owner } = await setup([{}], 1);
    const v = await viewerWs(taskId, sh);
    await v.waitFor((m) => m.type === 'auth_ok');

    v.send({ type: 'command', skillIds: ['mono-color'], imageRefs: refs, params: { title: 'x' } });
    const cmdErr = await v.waitFor((m) => m.type === 'error');
    expect(cmdErr).toMatchObject({ code: 'READONLY', retryable: false });

    v.send({ type: 'confirm', satisfaction: 'good' });
    const confErr = await v.waitFor((m) => m.type === 'error', 8000, 1);
    expect(confErr).toMatchObject({ code: 'READONLY', retryable: false });

    const snap = await json(`${gw.publicUrl}/auth`, 'POST', { sh, taskId });
    expect(snap.data.state).toBe('CREATED');

    // 所有者写路径零回归：同一任务 owner 仍可正常推进
    owner.send({ type: 'command', skillIds: ['mono-color'], imageRefs: refs, params: { title: '向北步行' } });
    await waitSettled(owner, 1);
    v.close();
    owner.close();
  });

  it('viewer auth：taskId 不匹配、伪造 sh、撤销后 → SHARE_INVALID error', async () => {
    const { token, taskId, sh } = await setup();

    const wrongTask = await connectWs(gw.wsUrl);
    wrongTask.send({ type: 'auth', role: 'viewer', token: sh, taskId: 'task_other' });
    expect(await wrongTask.waitFor((m) => m.type === 'error')).toMatchObject({ code: 'SHARE_INVALID' });
    wrongTask.close();

    const forged = await connectWs(gw.wsUrl);
    forged.send({ type: 'auth', role: 'viewer', token: 'sh_forged', taskId });
    expect(await forged.waitFor((m) => m.type === 'error')).toMatchObject({ code: 'SHARE_INVALID' });
    forged.close();

    await json(`${gw.publicUrl}/task/${taskId}/share`, 'DELETE', undefined, bearer(token));
    const revoked = await connectWs(gw.wsUrl);
    revoked.send({ type: 'auth', role: 'viewer', token: sh, taskId });
    expect(await revoked.waitFor((m) => m.type === 'error')).toMatchObject({ code: 'SHARE_INVALID' });
    revoked.close();
  });

  it('撤销分享：已建立的 viewer 连接下一次心跳即被服务端关闭，不再回 pong', async () => {
    const { token, taskId, sh, owner } = await setup();
    const v = await viewerWs(taskId, sh);
    await v.waitFor((m) => m.type === 'auth_ok');

    const del = await json(`${gw.publicUrl}/task/${taskId}/share`, 'DELETE', undefined, bearer(token));
    expect(del.data).toMatchObject({ revoked: true });

    v.send({ type: 'ping' }); // 心跳前复验 ShareStore：条目已删 → 关闭，不回 pong
    await waitServerClose(v, '撤销分享后已建立的 viewer 连接未被关闭');
    expect(v.received.some((m) => m.type === 'pong')).toBe(false);
    owner.close();
  });

  it('撤销分享：下一次广播前复验失效，viewer 收不到 state/progress 推送并被关闭', async () => {
    const { token, taskId, sh, refs, owner } = await setup([{}], 1);
    const v = await viewerWs(taskId, sh);
    await v.waitFor((m) => m.type === 'auth_ok');

    await json(`${gw.publicUrl}/task/${taskId}/share`, 'DELETE', undefined, bearer(token));
    const mark = v.received.length;
    owner.send({ type: 'command', skillIds: ['mono-color'], imageRefs: refs, params: { title: '向北步行' } });

    // 攻击场景复验：撤销后广播不再投递给旧 viewer，而是先断开
    await waitServerClose(v, '撤销分享后广播未关闭 viewer 连接');
    expect(v.received.slice(mark).some((m) => m.type === 'state' || m.type === 'progress' || m.type === 'result')).toBe(false);
    // owner 广播路径零回归：任务照常推进落定
    await waitSettled(owner);
    owner.close();
  });

  it('轮换分享（重复 POST）：旧 sh 的已建立 viewer 连接同样被关闭，新 sh 可用', async () => {
    const { token, taskId, sh, owner } = await setup();
    const v = await viewerWs(taskId, sh);
    await v.waitFor((m) => m.type === 'auth_ok');

    const again = await json<{ sh: string }>(`${gw.publicUrl}/task/${taskId}/share`, 'POST', undefined, bearer(token));
    expect(again.status).toBe(200);
    expect(again.data.sh).not.toBe(sh);

    v.send({ type: 'ping' }); // create 覆盖旧条目 → 旧 sh 复验失败即关闭
    await waitServerClose(v, '轮换分享后旧 sh 的 viewer 连接未被关闭');

    const snap = await json(`${gw.publicUrl}/auth`, 'POST', { sh: again.data.sh, taskId });
    expect(snap.status).toBe(200);
    owner.close();
  });
});
