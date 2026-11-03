import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Gateway } from '../src/app.js';
import type { CellSnapshot, Preset } from '../src/types.js';
import { FakeDsh } from './fake-dsh.js';
import { authedWs, json, startGateway, uploadImage, type WsClient } from './helpers.js';

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

async function setup(taskOpts: Array<Record<string, unknown>> = [{}], imageCount = 0) {
  const { tokens } = await issue(taskOpts);
  const refs: string[] = [];
  for (let i = 0; i < imageCount; i += 1) {
    const up = await uploadImage(`${gw.publicUrl}/upload`, tokens[0].token, new Uint8Array([137, 80, 78, 71, i]));
    expect(up.status).toBe(200);
    refs.push(String(up.data.imageRef));
  }
  const c = await authedWs(gw.wsUrl, tokens[0].token);
  return { token: tokens[0].token, taskId: tokens[0].taskId, refs, c };
}

/** 等任务落定为可修改/确认（所有格非 CREATED/RUNNING）；fromIndex 只看发指令后的新事件 */
function waitSettled(c: WsClient, timeout = 8000, fromIndex = 0): Promise<unknown> {
  return c.waitFor(
    (m) =>
      m.type === 'state' &&
      m.state === 'AWAITING_MODIFY_OR_CONFIRM' &&
      m.cells.every((s) => s.state !== 'CREATED' && s.state !== 'RUNNING'),
    timeout,
    fromIndex,
  );
}

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  dsh = new FakeDsh();
  gw = await startGateway({}, dsh);
});

afterEach(async () => {
  await gw.close();
});

describe('WS 鉴权与快照', () => {
  it('auth 成功回 auth_ok（taskId/state/preset/cells）；错误令牌回 TOKEN_INVALID；重复 auth 回 STATE_INVALID', async () => {
    const { token, c } = await setup();
    expect(c.received[0]).toMatchObject({ type: 'auth_ok', state: 'CREATED', cells: [] });
    expect((c.received[0] as { preset: Preset }).preset.allowedSkillIds).toEqual(['mono-color', 'duo-poster', 'text-poster']);

    // 同一连接重复登录
    c.send({ type: 'auth', token });
    const dup = await c.waitFor((m) => m.type === 'error');
    expect(dup).toMatchObject({ code: 'STATE_INVALID', retryable: false });

    // 新连接用坏令牌
    const { connectWs } = await import('./helpers.js');
    const bad = await connectWs(gw.wsUrl);
    bad.send({ type: 'auth', token: 'tk_nope' });
    const err = await bad.waitFor((m) => m.type === 'error');
    expect(err).toMatchObject({ code: 'TOKEN_INVALID' });
    bad.close();
    c.close();
  });
});

describe('首条指令：笛卡尔积展开', () => {
  it('2 技能 × 2 源图 → 4 个格，逐格流式进度与产出，落定 AWAITING', async () => {
    const { c, refs } = await setup([{}], 2);
    c.send({ type: 'command', skillIds: ['mono-color', 'text-poster'], imageRefs: refs, params: { title: '向北步行' }, text: '街景转单色海报' });

    const settled = (await waitSettled(c)) as { cells: CellSnapshot[] };
    expect(settled.cells).toHaveLength(4);
    expect(settled.cells.map((s) => s.cellId).sort()).toEqual(['cell_01', 'cell_02', 'cell_03', 'cell_04']);
    expect(settled.cells.every((s) => s.state === 'AWAITING_MODIFY_OR_CONFIRM')).toBe(true);
    expect(settled.cells.every((s) => s.outputs.length >= 1)).toBe(true);

    // 笛卡尔积：每个技能各出现 2 次（每张源图一次）
    expect(settled.cells.filter((s) => s.skill === 'mono-color')).toHaveLength(2);
    expect(settled.cells.filter((s) => s.skill === 'text-poster')).toHaveLength(2);

    // fake 侧收到 4 条 prompt，且源图分发：两张图各被用两次
    expect(dsh.prompts).toHaveLength(4);
    const sources = dsh.prompts.map((p) => JSON.parse(p.body.prompt).sourceImagePath as string);
    expect(new Set(sources).size).toBe(2);

    // 每格都有流式 progress，每个 result 带 out_ 引用与 url
    const progresses = c.received.filter((m) => m.type === 'progress');
    expect(progresses.length).toBeGreaterThanOrEqual(4);
    const results = c.received.filter((m) => m.type === 'result');
    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r).toMatchObject({ cellId: expect.stringMatching(/^cell_\d\d$/), url: expect.stringMatching(/^\/files\/out_/) });
      expect((r as { imageRef: string }).imageRef).toMatch(/^out_/);
    }
    c.close();
  });

  it('首条提交后状态机推进：RUNNING 聚合在途格', async () => {
    dsh.deltaMs = 40; // 拉开执行窗口
    const { c, refs } = await setup([{}], 1);
    c.send({ type: 'command', skillIds: ['mono-color'], imageRefs: refs, params: { title: '向北步行' } });
    const running = await c.waitFor((m) => m.type === 'state' && m.state === 'RUNNING');
    expect(running).toMatchObject({ state: 'RUNNING' });
    await waitSettled(c);
    c.close();
  });

  it('纯文生图：text-poster 不带 imageRefs 可出图；缺源图的 mono-color 首条 → IMAGE_REF_INVALID', async () => {
    // 任务 A：纯文生图可跑
    const a = await setup();
    a.c.send({ type: 'command', skillIds: ['text-poster'], params: { title: '夜航' } });
    await waitSettled(a.c);
    expect(a.c.received.filter((m) => m.type === 'result')).toHaveLength(1);
    a.c.close();

    // 任务 B（新令牌，尚未展开）：需要源图的技能缺 imageRefs → IMAGE_REF_INVALID
    const b = await setup();
    b.c.send({ type: 'command', skillIds: ['mono-color'], params: { title: 'x' } });
    const err = await b.c.waitFor((m) => m.type === 'error' && m.code === 'IMAGE_REF_INVALID');
    expect(err.retryable).toBe(false);
    b.c.close();
  });
});

describe('首条指令校验', () => {
  it('缺 skillIds → BAD_PARAMS；首条带 cellId → BAD_PARAMS；未知技能 → SKILL_UNKNOWN', async () => {
    const { c } = await setup();
    c.send({ type: 'command', text: 'hi' });
    await c.waitFor((m) => m.type === 'error' && m.code === 'BAD_PARAMS');

    c.send({ type: 'command', skillIds: ['text-poster'], cellId: 'cell_01', params: { title: 'x' } });
    await c.waitFor((m) => m.type === 'error' && m.code === 'BAD_PARAMS' && m.message?.includes('cellId'));

    c.send({ type: 'command', skillIds: ['no-such-skill'], params: { title: 'x' } });
    await c.waitFor((m) => m.type === 'error' && m.code === 'SKILL_UNKNOWN');
    c.close();
  });

  it('格数超 preset.maxCells → LIMIT', async () => {
    const { c, refs } = await setup([{ maxCells: 2 }], 2); // 2 图 × 2 技能 = 4 > 2
    c.send({ type: 'command', skillIds: ['mono-color', 'text-poster'], imageRefs: refs, params: { title: 'x' } });
    const err = await c.waitFor((m) => m.type === 'error' && m.code === 'LIMIT');
    expect(err).toMatchObject({ code: 'LIMIT' });
    c.close();
  });

  it('params 不符 Manifest schema → BAD_PARAMS（缺必填 title）', async () => {
    const { c } = await setup();
    c.send({ type: 'command', skillIds: ['text-poster'], params: {} });
    await c.waitFor((m) => m.type === 'error' && m.code === 'BAD_PARAMS' && m.message?.includes('title'));
    c.close();
  });

  it('超大消息（>maxPayloadBytes）→ PAYLOAD_TOO_LARGE', async () => {
    const { c } = await setup();
    c.send({ type: 'command', skillIds: ['text-poster'], params: { title: 'x' }, text: 'a'.repeat(300 * 1024) });
    await c.waitFor((m) => m.type === 'error' && m.code === 'PAYLOAD_TOO_LARGE');
    c.close();
  });
});

describe('修改与重试', () => {
  async function settledFirst() {
    const s = await setup([{}], 1);
    s.c.send({ type: 'command', skillIds: ['mono-color'], imageRefs: s.refs, params: { title: '向北步行' } });
    await waitSettled(s.c);
    return s;
  }

  it('修改格参数 → 同格重跑产出新 result；任务仍同任务', async () => {
    const { c } = await settledFirst();
    const mark = c.received.length;
    c.send({ type: 'command', cellId: 'cell_01', params: { title: '标题改成向北步行' } });
    const result = (await c.waitFor((m) => m.type === 'result', 8000, mark)) as { cellId: string };
    expect(result.cellId).toBe('cell_01');
    await waitSettled(c, 8000, mark);
    expect(c.received.filter((m) => m.type === 'result').length).toBe(2);
    c.close();
  });

  it('修改带 skillIds → SKILL_LOCKED；带 imageRefs → IMAGE_REF_INVALID', async () => {
    const { c } = await settledFirst();
    c.send({ type: 'command', cellId: 'cell_01', skillIds: ['duo-poster'], params: { title: 'x' } });
    await c.waitFor((m) => m.type === 'error' && m.code === 'SKILL_LOCKED');

    c.send({ type: 'command', cellId: 'cell_01', imageRefs: ['img_whatever'], params: { title: 'x' } });
    await c.waitFor((m) => m.type === 'error' && m.code === 'IMAGE_REF_INVALID' && m.message?.includes('禁止'));
    c.close();
  });

  it('editTarget 不属于该格 → EDIT_TARGET_INVALID；未知 cellId → STATE_INVALID', async () => {
    const { c } = await settledFirst();
    c.send({ type: 'command', cellId: 'cell_01', editTarget: 'out_foreign', params: { title: 'x' } });
    await c.waitFor((m) => m.type === 'error' && m.code === 'EDIT_TARGET_INVALID');

    c.send({ type: 'command', cellId: 'cell_99', params: { title: 'x' } });
    await c.waitFor((m) => m.type === 'error' && m.code === 'STATE_INVALID');
    c.close();
  });

  it('带合法 editTarget 修改 → prompt 携带该产出引用', async () => {
    const { c } = await settledFirst();
    const ref = (c.received.find((m) => m.type === 'result') as { imageRef: string }).imageRef;
    const mark = c.received.length;
    c.send({ type: 'command', cellId: 'cell_01', editTarget: ref, params: { title: '标题改一版' } });
    await waitSettled(c, 8000, mark);
    const last = dsh.prompts[dsh.prompts.length - 1];
    expect(JSON.parse(last.body.prompt).editTarget).toBe(ref);
    c.close();
  });

  it('指令频控：60s 窗口内超过 commandRateLimit → LIMIT', async () => {
    await gw.close();
    dsh = new FakeDsh();
    gw = await startGateway({ commandRateLimit: 2 }, dsh);
    const { c, refs } = await setup([{}], 1);
    c.send({ type: 'command', skillIds: ['mono-color'], imageRefs: refs, params: { title: 'a' } }); // 指令1
    await waitSettled(c);
    let mark = c.received.length;
    c.send({ type: 'command', cellId: 'cell_01', params: { title: 'b' } }); // 指令2
    await waitSettled(c, 8000, mark);
    mark = c.received.length;
    c.send({ type: 'command', cellId: 'cell_01', params: { title: 'c' } }); // 指令3 → 超限
    const err = await c.waitFor((m) => m.type === 'error' && m.code === 'LIMIT', 8000, mark);
    expect(err.retryable).toBe(false);
    c.close();
  });
});

describe('失败隔离与重试', () => {
  it('一个技能失败不影响其他格；失败格可同任务重试', async () => {
    dsh.failSkills.add('duo-poster');
    const { c, refs } = await setup([{}], 1);
    c.send({ type: 'command', skillIds: ['mono-color', 'duo-poster'], imageRefs: refs, params: { title: '向北步行' } });

    const settled = (await waitSettled(c)) as { cells: CellSnapshot[] };
    const mono = settled.cells.find((s) => s.skill === 'mono-color')!;
    const duo = settled.cells.find((s) => s.skill === 'duo-poster')!;
    expect(mono.state).toBe('AWAITING_MODIFY_OR_CONFIRM');
    expect(duo.state).toBe('FAILED');
    expect(duo.error).toMatchObject({ code: 'DSH_FAILED', retryable: true });

    const errEvt = await c.waitFor((m) => m.type === 'error' && m.cellId === duo.cellId);
    expect(errEvt).toMatchObject({ code: 'DSH_FAILED', retryable: true });

    // 重试：失败格可改（状态机允许 FAILED），修复 fake 后成功
    dsh.failSkills.delete('duo-poster');
    const mark = c.received.length;
    c.send({ type: 'command', cellId: duo.cellId, params: { title: '向北步行' } });
    const retried = (await waitSettled(c, 8000, mark)) as { cells: CellSnapshot[] };
    const duo2 = retried.cells.find((s) => s.skill === 'duo-poster')!;
    expect(duo2.state).toBe('AWAITING_MODIFY_OR_CONFIRM');
    expect(duo2.outputs.length).toBeGreaterThanOrEqual(1);
    expect(duo2.error).toBeUndefined();
    c.close();
  });

  it('执行中格不可修改（RUNNING 拒绝）', async () => {
    const release = dsh.holdSkill('mono-color');
    const { c, refs } = await setup([{}], 1);
    c.send({ type: 'command', skillIds: ['mono-color'], imageRefs: refs, params: { title: 'a' } });
    await c.waitFor((m) => m.type === 'state' && m.state === 'RUNNING');
    c.send({ type: 'command', cellId: 'cell_01', params: { title: 'b' } });
    const err = await c.waitFor((m) => m.type === 'error' && m.cellId === 'cell_01');
    expect(err).toMatchObject({ code: 'STATE_INVALID' });
    release();
    await waitSettled(c);
    c.close();
  });
});

describe('确认完成', () => {
  async function settledFirst(): Promise<{ c: WsClient; token: string }> {
    const s = await setup([{}], 1);
    s.c.send({ type: 'command', skillIds: ['mono-color'], imageRefs: s.refs, params: { title: '向北步行' } });
    await waitSettled(s.c);
    return { c: s.c, token: s.token };
  }

  it('确认 → state DONE + done 事件 + 全格 DONE，令牌转 USED；重复确认回错误，HTTP auth 回 TOKEN_USED', async () => {
    const { c, token } = await settledFirst();
    c.send({ type: 'confirm', satisfaction: 5 });
    const done = await c.waitFor((m) => m.type === 'done');
    expect(done).toMatchObject({ taskId: expect.stringContaining('task_') });

    const state = c.received.filter((m) => m.type === 'state').findLast((m) => m.state === 'DONE')!;
    expect(state).toBeDefined();
    expect((state as { cells: CellSnapshot[] }).cells.every((s) => s.state === 'DONE')).toBe(true);

    // 令牌刚被 confirm 置为 USED，重复确认在令牌复检处被拒（TOKEN_USED）或状态机拒绝，均符合契约
    c.send({ type: 'confirm', satisfaction: 5 });
    const rep = await c.waitFor((m) => m.type === 'error');
    expect(['STATE_INVALID', 'TOKEN_USED']).toContain(rep.code);

    // 令牌已作废：HTTP 层与 WS 新连接都应拒绝
    const auth = await json(`${gw.publicUrl}/auth`, 'POST', { token });
    expect(auth.status).toBe(401);
    expect(auth.data.error).toBe('TOKEN_USED');
    c.close();
  });

  it('未产出前确认 → STATE_INVALID；satisfaction 越界 → BAD_PARAMS', async () => {
    const { c } = await setup();
    c.send({ type: 'confirm', satisfaction: 5 });
    await c.waitFor((m) => m.type === 'error' && m.code === 'STATE_INVALID');

    c.send({ type: 'command', skillIds: ['text-poster'], params: { title: 'x' } });
    await waitSettled(c);
    c.send({ type: 'confirm', satisfaction: 9 });
    await c.waitFor((m) => m.type === 'error' && m.code === 'BAD_PARAMS');
    c.close();
  });
});

describe('心跳与广播', () => {
  it('ping → pong', async () => {
    const { c } = await setup();
    c.send({ type: 'ping' });
    await c.waitFor((m) => m.type === 'pong');
    c.close();
  });

  it('同任务多连接都收到广播；非本任务连接收不到', async () => {
    const a = await setup([{}], 1);
    const { connectWs } = await import('./helpers.js');
    const b = await connectWs(gw.wsUrl);
    b.send({ type: 'auth', token: a.token });
    await b.waitFor((m) => m.type === 'auth_ok');

    const other = await issue();
    const lonely = await connectWs(gw.wsUrl);
    lonely.send({ type: 'auth', token: other.tokens[0].token });
    await lonely.waitFor((m) => m.type === 'auth_ok');

    a.c.send({ type: 'command', skillIds: ['mono-color'], imageRefs: a.refs, params: { title: '向北步行' } });
    const stateB = await b.waitFor((m) => m.type === 'state');
    expect(stateB).toBeDefined();
    // 孤立连接不应收到任务事件（它只会有自己的 auth_ok）
    await settle(80);
    expect(lonely.received.every((m) => m.type === 'auth_ok')).toBe(true);

    lonely.close();
    b.close();
    a.c.close();
  });
});
