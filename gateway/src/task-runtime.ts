import { randomBytes } from 'node:crypto';
import type { DshClient, SessionFile } from './dsh-client.js';
import type { FileRegistry } from './files.js';
import type { Logger } from './logger.js';
import type { Scheduler } from './scheduler.js';
import type { TokenStore } from './token-store.js';
import type { Cell, CellSnapshot, Downlink, Preset, Task, TaskState } from './types.js';
import { GatewayError } from './types.js';
import type { FirstPlan, ModifyPlan } from './validation.js';

export interface TaskRuntimeDeps {
  dsh: DshClient;
  files: FileRegistry;
  scheduler: Scheduler;
  tokens: TokenStore;
  log: Logger;
  stallTimeoutMs: number;
  taskTtlMs: number;
  /** 失败格迟到产出补捞周期（毫秒） */
  salvageIntervalMs: number;
}

const IMAGE_PATH_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
/** 补捞上限：配合 salvageIntervalMs 约 5 分钟，之后放弃（失败格仍可手动重试） */
const SALVAGE_MAX_ATTEMPTS = 100;

/** 任务/单元状态机、状态聚合、产出登记、过期看门（backend-design §4/§5） */
export class TaskRuntime {
  private readonly tasks = new Map<string, Task>();
  private emitFn: (taskId: string, event: Downlink) => void = () => undefined;
  private watchdog: NodeJS.Timeout | null = null;
  /** 失败格补捞定时器（key = taskId/cellId） */
  private readonly salvageTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: TaskRuntimeDeps) {}

  onEmit(fn: (taskId: string, event: Downlink) => void): void {
    this.emitFn = fn;
  }

  /** 签发即建任务会话（staging，backend-design §5） */
  async createTask(opts: { orderRef: string; codeRef: string | null; preset: Preset; now?: number }): Promise<Task> {
    const stagingSessionId = await this.deps.dsh.createSession();
    const task: Task = {
      taskId: `task_${randomBytes(9).toString('base64url')}`,
      orderRef: opts.orderRef,
      codeRef: opts.codeRef,
      preset: opts.preset,
      state: 'CREATED',
      stagingSessionId,
      expanded: false,
      cells: new Map(),
      createdAt: opts.now ?? Date.now(),
      commandTimes: [],
    };
    this.tasks.set(task.taskId, task);
    this.deps.log.info('task.created', { taskId: task.taskId, orderRef: opts.orderRef, stagingSessionId });
    return task;
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  tasksByOrder(orderRef: string): Task[] {
    return [...this.tasks.values()].filter((t) => t.orderRef === orderRef);
  }

  cellsSnapshot(task: Task): CellSnapshot[] {
    return [...task.cells.values()].map((c) => ({
      cellId: c.cellId,
      skill: c.skill,
      state: c.state,
      outputs: [...c.outputs],
      ...(c.error ? { error: { ...c.error } } : {}),
    }));
  }

  /** 任务状态是格态的派生值（backend-design §4） */
  deriveTaskState(task: Task): TaskState {
    if (task.state === 'DONE' || task.state === 'EXPIRED') return task.state;
    if (!task.expanded || task.cells.size === 0) return 'CREATED';
    const cells = [...task.cells.values()];
    if (cells.some((c) => c.state === 'RUNNING' || c.state === 'CREATED')) return 'RUNNING';
    return 'AWAITING_MODIFY_OR_CONFIRM';
  }

  private refresh(task: Task): void {
    task.state = this.deriveTaskState(task);
  }

  private stateEvent(task: Task): Downlink {
    return { type: 'state', state: task.state, cells: this.cellsSnapshot(task) };
  }

  private emitState(task: Task): void {
    this.refresh(task);
    this.emitFn(task.taskId, this.stateEvent(task));
  }

  /* ---------- 首条指令：笛卡尔积展开 ---------- */

  async executeFirst(task: Task, plan: FirstPlan): Promise<void> {
    task.expanded = true;
    for (const pair of plan.pairs) {
      task.cells.set(pair.cellId, {
        cellId: pair.cellId,
        skill: pair.skill,
        sourceRef: pair.sourceRef,
        sourcePath: null,
        sessionId: null,
        state: 'CREATED',
        outputs: [],
        params: { ...plan.params },
        text: plan.text,
        editTarget: null,
      });
    }
    this.emitState(task);
    for (const cell of [...task.cells.values()]) {
      void this.runCell(task, cell).catch((err) => {
        this.deps.log.error('cell.crash', { taskId: task.taskId, cellId: cell.cellId, err: String(err) });
      });
    }
  }

  /* ---------- 修改/重试指令：入格 ---------- */

  async executeModify(task: Task, plan: ModifyPlan): Promise<void> {
    const cell = task.cells.get(plan.cellId);
    if (!cell) throw new GatewayError('STATE_INVALID', '单元不存在', plan.cellId);
    cell.params = { ...plan.params };
    cell.text = plan.text;
    cell.editTarget = plan.editTarget;
    cell.error = undefined;
    cell.state = 'CREATED'; // 排队态（backend-design §6）
    this.emitState(task);
    await this.runCell(task, cell);
  }

  /* ---------- 格执行：会话 → 源图分发 → prompt-stream → 产出差量 ---------- */

  private async runCell(task: Task, cell: Cell): Promise<void> {
    await this.deps.scheduler.run(async () => {
      if (cell.state !== 'CREATED' && cell.state !== 'FAILED' && cell.state !== 'AWAITING_MODIFY_OR_CONFIRM') return;
      cell.state = 'RUNNING';
      cell.error = undefined;
      this.emitState(task);
      try {
        if (!cell.sessionId) cell.sessionId = await this.deps.dsh.createSession();
        if (cell.sourceRef && !cell.sourcePath) {
          const entry = this.deps.files.get(cell.sourceRef);
          if (!entry) throw new GatewayError('IMAGE_REF_INVALID', '源图引用失效', cell.cellId);
          const data = await this.deps.dsh.downloadFile(entry.sessionId, entry.path);
          const filename = entry.path.split('/').pop() ?? 'source.png';
          cell.sourcePath = await this.deps.dsh.uploadFile(cell.sessionId, filename, data, 'image/png');
        }
        const prompt = JSON.stringify({
          skill: cell.skill,
          params: cell.params,
          text: cell.text,
          sourceImagePath: cell.sourcePath,
          editTarget: cell.editTarget,
        });
        await this.deps.dsh.promptStream(
          cell.sessionId,
          { prompt, stallTimeoutMs: this.deps.stallTimeoutMs },
          (delta) => this.emitFn(task.taskId, { type: 'progress', cellId: cell.cellId, source: 'dsh', delta }),
        );
        await this.discoverOutputs(task, cell);
        // agent 正常收尾但一张图都没产出 = 实际失败；不置错会让前端永远停在"生成中"
        if (cell.outputs.length === 0) {
          throw new GatewayError('DSH_FAILED', 'agent 执行结束但未产出图片', cell.cellId);
        }
        cell.state = 'AWAITING_MODIFY_OR_CONFIRM';
      } catch (err) {
        const code: string =
          err instanceof GatewayError && (err.code === 'DSH_FAILED' || err.code === 'DSH_TIMEOUT')
            ? err.code
            : 'DSH_FAILED';
        // 流报错/零产出时 agent 可能已落图：先补捞一次差量，捞到即视为完成（WS 活着即收到 result）
        let salvaged = 0;
        try {
          salvaged = await this.discoverOutputs(task, cell);
        } catch (salvageErr) {
          this.deps.log.warn('cell.salvage_failed', { taskId: task.taskId, cellId: cell.cellId, err: String(salvageErr) });
        }
        if (salvaged > 0) {
          cell.state = 'AWAITING_MODIFY_OR_CONFIRM';
          cell.error = undefined;
          this.deps.log.info('cell.salvaged', { taskId: task.taskId, cellId: cell.cellId, code });
        } else {
          cell.state = 'FAILED';
          cell.error = { code, retryable: true };
          this.deps.log.warn('cell.failed', { taskId: task.taskId, cellId: cell.cellId, code, msg: String(err) });
          this.emitFn(task.taskId, {
            type: 'error',
            cellId: cell.cellId,
            code,
            retryable: true,
            message: String(err instanceof Error ? err.message : err).slice(0, 300),
          });
          this.startSalvage(task.taskId, cell.cellId);
        }
      }
      this.emitState(task);
    });
  }

  /* ---------- 失败格迟到产出补捞：WS 活跃期间周期差量，把 agent 迟到的图推给前端 ---------- */

  private startSalvage(taskId: string, cellId: string): void {
    const key = `${taskId}/${cellId}`;
    if (this.salvageTimers.has(key)) return;
    const loop = (attempt: number): void => {
      const timer = setTimeout(() => void this.salvageTick(key, attempt, loop), this.deps.salvageIntervalMs);
      timer.unref?.();
      this.salvageTimers.set(key, timer);
    };
    loop(1);
  }

  private async salvageTick(key: string, attempt: number, loop: (next: number) => void): Promise<void> {
    const sep = key.indexOf('/');
    const task = this.tasks.get(key.slice(0, sep));
    const cell = task?.cells.get(key.slice(sep + 1));
    // 停止条件：任务落定、无会话、或格已离开 FAILED（重试已开跑）
    if (!task || !cell || !cell.sessionId || cell.state !== 'FAILED' || task.state === 'DONE' || task.state === 'EXPIRED') {
      this.salvageTimers.delete(key);
      return;
    }
    let found = 0;
    try {
      found = await this.discoverOutputs(task, cell);
    } catch (err) {
      this.deps.log.warn('cell.salvage_failed', { taskId: task.taskId, cellId: cell.cellId, err: String(err) });
    }
    // 补到图 → 翻回可确认态（期间格被重试接手则不动状态，只保留已登记产出）
    if (found > 0 && cell.state === 'FAILED') {
      this.salvageTimers.delete(key);
      cell.state = 'AWAITING_MODIFY_OR_CONFIRM';
      cell.error = undefined;
      this.deps.log.info('cell.salvaged', { taskId: task.taskId, cellId: cell.cellId, attempt });
      this.emitState(task);
      return;
    }
    if (attempt >= SALVAGE_MAX_ATTEMPTS) {
      this.salvageTimers.delete(key);
      return;
    }
    loop(attempt + 1);
  }

  stopSalvage(): void {
    for (const timer of this.salvageTimers.values()) clearTimeout(timer);
    this.salvageTimers.clear();
  }

  /** 每格每轮结束后对格会话文件差量，新图登记为 out_*（backend-design §5）；真实 agent 产出常在子目录（如 deliverable/），递归下钻。返回本轮新登记数量 */
  private async discoverOutputs(task: Task, cell: Cell): Promise<number> {
    if (!cell.sessionId) return 0;
    const known = this.deps.files.pathsOf(cell.cellId);
    const walked = new Set<string>();
    const found: SessionFile[] = [];
    const walk = async (subdir: string | undefined, depth: number): Promise<void> => {
      const key = subdir ?? '';
      if (walked.has(key)) return;
      walked.add(key);
      const list =
        subdir === undefined
          ? await this.deps.dsh.listFiles(cell.sessionId as string)
          : await this.deps.dsh.listFiles(cell.sessionId as string, subdir);
      for (const f of list) {
        if (f.type === 'dir') {
          if (depth > 0) await walk(f.path, depth - 1);
          continue;
        }
        if (!IMAGE_PATH_RE.test(f.path)) continue;
        if (f.path === cell.sourcePath) continue; // 复制进来的源图不是产出
        if (known.has(f.path)) continue;
        known.add(f.path);
        found.push(f);
      }
    };
    await walk(undefined, 2);
    // await 后按登记表重新判重：补捞 tick 与重试轮可能并发做差量（同一路径双登记 → 双 ref/双 result）。
    // 判重到登记之间无 await，先恢复者落库、后恢复者在此跳过；后续轮次的新图不受影响（未登记过 → 仍会入列）
    const registered = this.deps.files.pathsOf(cell.cellId);
    const fresh = found.filter((f) => !registered.has(f.path));
    for (const f of fresh) {
      const entry = this.deps.files.registerOutput(cell.sessionId, f.path, cell.cellId);
      cell.outputs.push(entry.ref);
      this.emitFn(task.taskId, { type: 'result', cellId: cell.cellId, imageRef: entry.ref, url: `/files/${entry.ref}` });
    }
    return fresh.length;
  }

  /* ---------- 确认与过期 ---------- */

  /** 整批确认：全部格置 DONE、令牌作废、会话收尾（调用方先过 validateConfirm） */
  confirm(task: Task, satisfaction: number | undefined): void {
    for (const cell of task.cells.values()) {
      cell.state = 'DONE';
      cell.error = undefined;
    }
    task.state = 'DONE';
    if (satisfaction !== undefined) task.satisfaction = satisfaction;
    this.deps.log.info('task.confirmed', { taskId: task.taskId, satisfaction });
    this.emitState(task);
    this.emitFn(task.taskId, { type: 'done', taskId: task.taskId });
    void this.cancelAllSessions(task);
  }

  /** 24h 无确认 → EXPIRED；联动令牌与会话 */
  expire(task: Task): void {
    if (task.state === 'DONE' || task.state === 'EXPIRED') return;
    task.state = 'EXPIRED';
    for (const cell of task.cells.values()) {
      if (cell.state !== 'DONE') cell.state = 'EXPIRED';
    }
    for (const token of this.deps.tokens.list()) {
      if (token.taskId === task.taskId && token.state === 'ACTIVE') token.state = 'EXPIRED';
    }
    this.deps.log.info('task.expired', { taskId: task.taskId });
    this.emitState(task);
    void this.cancelAllSessions(task);
  }

  startWatchdog(intervalMs = 60_000): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.sweep(), intervalMs);
    this.watchdog.unref?.();
  }

  stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  sweep(now = Date.now()): void {
    for (const task of this.tasks.values()) {
      if (task.state === 'DONE') continue;
      if (now - task.createdAt >= this.deps.taskTtlMs) this.expire(task);
    }
  }

  private async cancelAllSessions(task: Task): Promise<void> {
    const ids = [task.stagingSessionId, ...[...task.cells.values()].map((c) => c.sessionId)].filter(
      (id): id is string => Boolean(id),
    );
    await Promise.all(ids.map((id) => this.deps.dsh.cancelSession(id).catch(() => undefined)));
  }
}
