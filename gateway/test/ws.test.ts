import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Gateway } from '../src/app.js';
import type { CellSnapshot, Preset, StateMsg } from '../src/types.js';
import { FakeDsh } from './fake-dsh.js';
import { authedWs, json, startGateway, until, uploadImage, type WsClient } from './helpers.js';

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

/** 直读 runtime 私有补捞定时器表（补捞清理断言用） */
const salvageTimersOf = (runtime: Gateway['runtime']): Map<string, unknown> =>
  (runtime as unknown as { salvageTimers: Map<string, unknown> }).salvageTimers;

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
    expect((c.received[0] as { preset: Preset }).preset.allowedSkillIds).toEqual([
      'mono-color',
      'paperworldphoto',
      'photo-story',
      'real-qgraffiti-illusion',
      'second-world-poster',
      'western-animation-concept-portrait',
    ]);

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
    c.send({ type: 'command', skillIds: ['mono-color', 'photo-story'], imageRefs: refs, params: { title: '向北步行' }, text: '街景转单色海报' });

    const settled = (await waitSettled(c)) as { cells: CellSnapshot[] };
    expect(settled.cells).toHaveLength(4);
    expect(settled.cells.map((s) => s.cellId).sort()).toEqual(['cell_01', 'cell_02', 'cell_03', 'cell_04']);
    expect(settled.cells.every((s) => s.state === 'AWAITING_MODIFY_OR_CONFIRM')).toBe(true);
    expect(settled.cells.every((s) => s.outputs.length >= 1)).toBe(true);

    // 笛卡尔积：每个技能各出现 2 次（每张源图一次）
    expect(settled.cells.filter((s) => s.skill === 'mono-color')).toHaveLength(2);
    expect(settled.cells.filter((s) => s.skill === 'photo-story')).toHaveLength(2);

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

  it('同一网关多任务：不同任务的同名格（cell_01）产出互不串扰，后一个任务照常出图落定', async () => {
    const a = await setup([{}], 1);
    a.c.send({ type: 'command', skillIds: ['mono-color'], imageRefs: a.refs, params: { title: '任务甲' } });
    const settledA = (await waitSettled(a.c)) as { cells: CellSnapshot[] };
    expect(settledA.cells[0].cellId).toBe('cell_01');
    expect(settledA.cells[0].outputs.length).toBeGreaterThanOrEqual(1);
    a.c.close();

    // 第二个任务同样展开出 cell_01，产出差量不得被前一任务同名格的登记记录误判为已登记
    const b = await setup([{}], 1);
    b.c.send({ type: 'command', skillIds: ['mono-color'], imageRefs: b.refs, params: { title: '任务乙' } });
    const settledB = (await waitSettled(b.c)) as { cells: CellSnapshot[] };
    expect(settledB.cells[0].state).toBe('AWAITING_MODIFY_OR_CONFIRM');
    expect(settledB.cells[0].outputs.length).toBeGreaterThanOrEqual(1);
    expect(b.c.received.filter((m) => m.type === 'result')).toHaveLength(settledB.cells[0].outputs.length);
    b.c.close();
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

  it('缺源图的首条 → IMAGE_REF_INVALID（清单技能全部需要源图）', async () => {
    for (const skill of ['mono-color', 'photo-story']) {
      const s = await setup();
      s.c.send({ type: 'command', skillIds: [skill], params: { title: 'x' } });
      const err = await s.c.waitFor((m) => m.type === 'error' && m.code === 'IMAGE_REF_INVALID');
      expect(err.retryable).toBe(false);
      s.c.close();
    }
  });
});

describe('首条指令校验', () => {
  it('缺 skillIds → BAD_PARAMS；首条带 cellId → BAD_PARAMS；未知技能 → SKILL_UNKNOWN', async () => {
    const { c } = await setup();
    c.send({ type: 'command', text: 'hi' });
    await c.waitFor((m) => m.type === 'error' && m.code === 'BAD_PARAMS');

    c.send({ type: 'command', skillIds: ['photo-story'], cellId: 'cell_01', params: { title: 'x' } });
    await c.waitFor((m) => m.type === 'error' && m.code === 'BAD_PARAMS' && m.message?.includes('cellId'));

    c.send({ type: 'command', skillIds: ['no-such-skill'], params: { title: 'x' } });
    await c.waitFor((m) => m.type === 'error' && m.code === 'SKILL_UNKNOWN');
    c.close();
  });

  it('格数超 preset.maxCells → LIMIT', async () => {
    const { c, refs } = await setup([{ maxCells: 2 }], 2); // 2 图 × 2 技能 = 4 > 2
    c.send({ type: 'command', skillIds: ['mono-color', 'photo-story'], imageRefs: refs, params: { title: 'x' } });
    const err = await c.waitFor((m) => m.type === 'error' && m.code === 'LIMIT');
    expect(err).toMatchObject({ code: 'LIMIT' });
    c.close();
  });

  it('params 不符 Manifest schema → BAD_PARAMS（缺必填 title）', async () => {
    const { c } = await setup();
    c.send({ type: 'command', skillIds: ['photo-story'], params: {} });
    await c.waitFor((m) => m.type === 'error' && m.code === 'BAD_PARAMS' && m.message?.includes('title'));
    c.close();
  });

  it('超大消息（>maxPayloadBytes）→ PAYLOAD_TOO_LARGE', async () => {
    const { c } = await setup();
    c.send({ type: 'command', skillIds: ['photo-story'], params: { title: 'x' }, text: 'a'.repeat(300 * 1024) });
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
    c.send({ type: 'command', cellId: 'cell_01', skillIds: ['paperworldphoto'], params: { title: 'x' } });
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
    dsh.failSkills.add('paperworldphoto');
    const { c, refs } = await setup([{}], 1);
    c.send({ type: 'command', skillIds: ['mono-color', 'paperworldphoto'], imageRefs: refs, params: { title: '向北步行' } });

    const settled = (await waitSettled(c)) as { cells: CellSnapshot[] };
    const mono = settled.cells.find((s) => s.skill === 'mono-color')!;
    const pw = settled.cells.find((s) => s.skill === 'paperworldphoto')!;
    expect(mono.state).toBe('AWAITING_MODIFY_OR_CONFIRM');
    expect(pw.state).toBe('FAILED');
    expect(pw.error).toMatchObject({ code: 'DSH_FAILED', retryable: true });

    const errEvt = await c.waitFor((m) => m.type === 'error' && m.cellId === pw.cellId);
    expect(errEvt).toMatchObject({ code: 'DSH_FAILED', retryable: true });

    // 重试：失败格可改（状态机允许 FAILED），修复 fake 后成功
    dsh.failSkills.delete('paperworldphoto');
    const mark = c.received.length;
    c.send({ type: 'command', cellId: pw.cellId, params: { title: '向北步行' } });
    const retried = (await waitSettled(c, 8000, mark)) as { cells: CellSnapshot[] };
    const pw2 = retried.cells.find((s) => s.skill === 'paperworldphoto')!;
    expect(pw2.state).toBe('AWAITING_MODIFY_OR_CONFIRM');
    expect(pw2.outputs.length).toBeGreaterThanOrEqual(1);
    expect(pw2.error).toBeUndefined();
    c.close();
  });

  it('agent 正常收尾但零产出 → 格 FAILED 可重试（前端不再永久"生成中"）', async () => {
    dsh.silentOutputs = true;
    const { c, refs } = await setup([{}], 1);
    c.send({ type: 'command', skillIds: ['mono-color'], imageRefs: refs, params: { title: 'a' } });

    const settled = (await waitSettled(c)) as { cells: CellSnapshot[] };
    const cell = settled.cells[0];
    expect(cell.state).toBe('FAILED');
    expect(cell.outputs).toHaveLength(0);
    expect(cell.error).toMatchObject({ code: 'DSH_FAILED', retryable: true });
    const errEvt = await c.waitFor((m) => m.type === 'error' && m.cellId === cell.cellId);
    expect(errEvt).toMatchObject({ code: 'DSH_FAILED', retryable: true });

    // 重试后恢复出图
    dsh.silentOutputs = false;
    const mark = c.received.length;
    c.send({ type: 'command', cellId: cell.cellId, params: { title: 'b' } });
    const retried = (await waitSettled(c, 8000, mark)) as { cells: CellSnapshot[] };
    const cell2 = retried.cells.find((s) => s.cellId === cell.cellId)!;
    expect(cell2.state).toBe('AWAITING_MODIFY_OR_CONFIRM');
    expect(cell2.outputs.length).toBeGreaterThanOrEqual(1);
    expect(cell2.error).toBeUndefined();
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

  it('流报错但 agent 已落图 → 补捞产出直接落定可确认，不发格级 error', async () => {
    dsh.failAfterOutputSkills.add('mono-color');
    const { c, refs } = await setup([{}], 1);
    c.send({ type: 'command', skillIds: ['mono-color'], imageRefs: refs, params: { title: 'a' } });

    const settled = (await waitSettled(c)) as { cells: CellSnapshot[] };
    const cell = settled.cells[0];
    expect(cell.state).toBe('AWAITING_MODIFY_OR_CONFIRM');
    expect(cell.outputs.length).toBeGreaterThanOrEqual(1);
    expect(cell.error).toBeUndefined();
    expect(c.received.some((m) => m.type === 'error')).toBe(false);
    c.close();
  });

  it('失败后才落的图：WS 存活期间周期补捞，登记产出并翻回可确认态', async () => {
    dsh.failSkills.add('mono-color');
    const { c, refs } = await setup([{}], 1);
    c.send({ type: 'command', skillIds: ['mono-color'], imageRefs: refs, params: { title: 'a' } });

    const settled = (await waitSettled(c)) as { cells: CellSnapshot[] };
    expect(settled.cells[0].state).toBe('FAILED');
    const errEvt = await c.waitFor((m) => m.type === 'error' && m.cellId === settled.cells[0].cellId);
    expect(errEvt).toMatchObject({ code: 'DSH_FAILED', retryable: true });

    // agent 迟到产出：往格会话塞一张图（模拟 DSH 侧稍后落盘）
    const sid = dsh.prompts[0].sessionId;
    const mark = c.received.length;
    dsh.sessions.get(sid)!.set('late-01.png', Buffer.from('late-png'));

    const state = (await c.waitFor(
      (m) => m.type === 'state' && m.cells[0]?.state === 'AWAITING_MODIFY_OR_CONFIRM',
      8000,
      mark,
    )) as { cells: CellSnapshot[] };
    const cell = state.cells[0];
    expect(cell.outputs).toHaveLength(1);
    expect(cell.error).toBeUndefined();
    const result = c.received.slice(mark).find((m) => m.type === 'result');
    expect(result).toMatchObject({ cellId: cell.cellId, url: expect.stringMatching(/^\/files\/out_/) });
    c.close();
  });

  it('补捞达到上限后放弃：salvage 停止轮询，不再调用 listFiles、不翻状态', async () => {
    await gw.close();
    dsh = new FakeDsh();
    gw = await startGateway({ salvageIntervalMs: 1 }, dsh); // 100 tick × 1ms，秒级收敛（上限仍为生产常量 100）
    dsh.failSkills.add('mono-color');
    const { c, refs } = await setup([{}], 1);
    c.send({ type: 'command', skillIds: ['mono-color'], imageRefs: refs, params: { title: 'a' } });
    const settled = (await waitSettled(c)) as { cells: CellSnapshot[] };
    expect(settled.cells[0].state).toBe('FAILED');

    // listFiles 只来自差量发现：失败时即时补捞 1 次 + 补捞循环上限 100 次 = 101 次，之后放弃
    await until(() => dsh.listFilesCalls >= 101, 8000, 5);
    await settle(120); // 远超 1ms 补捞周期：若未放弃，计数会继续增长
    expect(dsh.listFilesCalls).toBe(101);
    expect(salvageTimersOf(gw.runtime).size).toBe(0);
    const states = c.received.filter((m): m is StateMsg => m.type === 'state');
    expect(states.at(-1)?.cells[0]?.state).toBe('FAILED'); // 放弃 ≠ 翻状态，格仍可手动重试
    c.close();
  });

  it('重试接手后旧补捞定时器停止：RUNNING 期间不再 listFiles、状态不被补捞翻动', async () => {
    dsh.failSkills.add('mono-color');
    const { c, refs } = await setup([{}], 1);
    c.send({ type: 'command', skillIds: ['mono-color'], imageRefs: refs, params: { title: 'a' } });
    const settled = (await waitSettled(c)) as { cells: CellSnapshot[] };
    expect(settled.cells[0].state).toBe('FAILED');
    const sid = dsh.prompts[0].sessionId;
    await until(() => salvageTimersOf(gw.runtime).size === 1); // 补捞已启动

    // 用户重试：hold 技能让格停在 RUNNING；格离开 FAILED 后旧补捞 tick 应自清
    const release = dsh.holdSkill('mono-color');
    dsh.failSkills.delete('mono-color');
    const mark = c.received.length;
    c.send({ type: 'command', cellId: 'cell_01', params: { title: 'b' } });
    await c.waitFor((m) => m.type === 'state' && m.state === 'RUNNING', 8000, mark);
    await settle(100); // 略超一个补捞周期：让在途/末次 tick 完成清理
    expect(salvageTimersOf(gw.runtime).size).toBe(0);

    // 定时器已清理 → 之后不再 listFiles；期间塞入的迟到图不会被旧补捞登记/下发
    const calls = dsh.listFilesCalls;
    dsh.sessions.get(sid)!.set('late-01.png', Buffer.from('late-png'));
    await settle(200);
    expect(dsh.listFilesCalls).toBe(calls);
    const during = c.received.slice(mark);
    expect(during.some((m) => m.type === 'result')).toBe(false);
    expect(
      during.some((m) => m.type === 'state' && m.cells[0]?.state === 'AWAITING_MODIFY_OR_CONFIRM'),
    ).toBe(false);

    // 放行重试：正常落定，产出照常登记
    release();
    const done = (await waitSettled(c, 8000, mark)) as { cells: CellSnapshot[] };
    expect(done.cells[0].state).toBe('AWAITING_MODIFY_OR_CONFIRM');
    expect(done.cells[0].outputs.length).toBeGreaterThanOrEqual(1);
    c.close();
  });

  it('stopSalvage()/close() 后无残留补捞定时器：salvageTimers 清空、后续不再 listFiles', async () => {
    dsh.failSkills.add('mono-color');
    const { c, refs } = await setup([{}], 1);
    c.send({ type: 'command', skillIds: ['mono-color'], imageRefs: refs, params: { title: 'a' } });
    const settled = (await waitSettled(c)) as { cells: CellSnapshot[] };
    expect(settled.cells[0].state).toBe('FAILED');
    await until(() => salvageTimersOf(gw.runtime).size === 1);

    // 1) stopSalvage()：定时器表立即清空，之后不再有 listFiles
    gw.runtime.stopSalvage();
    expect(salvageTimersOf(gw.runtime).size).toBe(0);
    const calls = dsh.listFilesCalls;
    await settle(150); // 3 个补捞周期
    expect(dsh.listFilesCalls).toBe(calls);

    // 2) close()（内部同走 stopSalvage）：再次启动补捞后关停，无残留定时器
    const mark = c.received.length;
    c.send({ type: 'command', cellId: 'cell_01', params: { title: 'b' } }); // 仍失败 → 重新启动补捞
    await c.waitFor((m) => m.type === 'error' && m.cellId === 'cell_01', 8000, mark);
    await until(() => salvageTimersOf(gw.runtime).size === 1);
    await gw.close();
    expect(salvageTimersOf(gw.runtime).size).toBe(0);
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
    const { c, refs } = await setup([{}], 1);
    c.send({ type: 'confirm', satisfaction: 5 });
    await c.waitFor((m) => m.type === 'error' && m.code === 'STATE_INVALID');

    c.send({ type: 'command', skillIds: ['mono-color'], imageRefs: refs, params: { title: 'x' } });
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
