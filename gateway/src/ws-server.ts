import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { requireShare, requireToken } from './auth.js';
import type { HttpApiDeps } from './http-api.js';
import { hashToken } from './logger.js';
import type { Downlink, Task, Uplink } from './types.js';
import { GatewayError } from './types.js';

interface Conn {
  ws: WebSocket;
  token?: string;
  taskId?: string;
  /** viewer = 只读分享连接（ADR-0008）：可订阅 state，所有写指令拒绝 */
  role?: 'viewer';
  /** viewer 认证用的分享令牌：广播/心跳前据此复验 ShareStore，撤销/轮换/过期即断开 */
  sh?: string;
}

/** WS 消息路由：auth/command/confirm/ping ↔ auth_ok/state/progress/result/error/done/pong（gateway-interface §4.2） */
export class WsServer {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly conns = new Set<Conn>();

  constructor(private readonly deps: HttpApiDeps) {}

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0];
      if (path !== '/ws') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    });
    this.wss.on('connection', (ws) => this.onConnection(ws));
  }

  /** 任务事件广播到该任务的全部连接（同令牌多标签页）；viewer 先复验分享，失效即断开不投递 */
  broadcast(taskId: string, event: Downlink): void {
    const data = JSON.stringify(event);
    for (const conn of this.conns) {
      if (conn.taskId !== taskId) continue;
      if (!this.viewerShareAlive(conn)) continue;
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(data);
    }
  }

  /** viewer 分享复验（撤销/轮换/任务过期/超 TTL 即失效）：失效即关闭连接并摘除，返回是否仍可投递 */
  private viewerShareAlive(conn: Conn): boolean {
    if (conn.role !== 'viewer') return true;
    try {
      requireShare(this.deps.shares, conn.sh, conn.taskId, this.deps.runtime, this.deps.config.taskTtlMs);
      return true;
    } catch {
      this.conns.delete(conn);
      conn.ws.close();
      this.deps.log.info('ws.viewer.share_invalid', { taskId: conn.taskId });
      return false;
    }
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  close(): void {
    for (const conn of this.conns) conn.ws.close();
    this.conns.clear();
    this.wss.close();
  }

  private onConnection(ws: WebSocket): void {
    const conn: Conn = { ws };
    this.conns.add(conn);
    ws.on('message', (raw) => void this.onMessage(conn, raw));
    ws.on('close', () => this.conns.delete(conn));
    ws.on('error', () => this.conns.delete(conn));
  }

  private send(conn: Conn, event: Downlink): void {
    if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(JSON.stringify(event));
  }

  private async onMessage(conn: Conn, raw: WebSocket.RawData): Promise<void> {
    const bytes = typeof raw === 'string' ? Buffer.byteLength(raw) : Array.isArray(raw) ? Buffer.concat(raw).length : raw.byteLength;
    if (bytes > this.deps.config.maxPayloadBytes) {
      this.send(conn, { type: 'error', code: 'PAYLOAD_TOO_LARGE', retryable: false });
      return;
    }
    const text = typeof raw === 'string' ? raw : Buffer.concat(Array.isArray(raw) ? raw : [raw as Buffer]).toString('utf8');
    let msg: Uplink;
    try {
      msg = JSON.parse(text) as Uplink;
    } catch {
      this.send(conn, { type: 'error', code: 'BAD_PARAMS', retryable: false, message: '消息不是合法 JSON' });
      return;
    }
    if (typeof msg !== 'object' || msg === null || typeof (msg as { type?: unknown }).type !== 'string') {
      this.send(conn, { type: 'error', code: 'BAD_PARAMS', retryable: false });
      return;
    }
    // viewer 上行前复验分享（心跳/写指令同口）：撤销、轮换、任务或分享 TTL 过期 → 关闭，不再回 pong
    if (!this.viewerShareAlive(conn)) return;
    try {
      switch (msg.type) {
        case 'auth':
          this.handleAuth(conn, msg);
          return;
        case 'ping':
          this.send(conn, { type: 'pong' });
          return;
        case 'command':
          this.handleCommand(conn, msg);
          return;
        case 'confirm':
          this.handleConfirm(conn, msg.satisfaction);
          return;
        default:
          this.send(conn, { type: 'error', code: 'BAD_PARAMS', retryable: false, message: `未知消息类型` });
      }
    } catch (err) {
      if (err instanceof GatewayError) {
        this.send(conn, {
          type: 'error',
          code: err.code,
          retryable: false,
          ...(err.cellId ? { cellId: err.cellId } : {}),
          message: err.message,
        });
      } else {
        this.deps.log.error('ws.error', { err: String(err) });
        this.send(conn, { type: 'error', code: 'STATE_INVALID', retryable: false, message: '内部错误' });
      }
    }
  }

  private handleAuth(conn: Conn, msg: Extract<Uplink, { type: 'auth' }>): void {
    if (conn.taskId) throw new GatewayError('STATE_INVALID', '连接已登录');
    let task: Task;
    if (msg.role === 'viewer') {
      // 只读分享（ADR-0008）：viewer 无 tk_*，凭 sh_* + taskId 订阅本任务；伪造/撤销/任务过期 → 403 语义
      const shared = requireShare(this.deps.shares, msg.token, msg.taskId, this.deps.runtime, this.deps.config.taskTtlMs);
      task = shared.task;
      conn.role = 'viewer';
      conn.sh = shared.entry.token;
      this.deps.log.info('ws.auth.viewer', { taskId: task.taskId, sh: hashToken(shared.entry.token) });
    } else {
      const t = requireToken(this.deps.tokens, msg.token);
      const ownerTask = this.deps.runtime.get(t.taskId);
      if (!ownerTask) throw new GatewayError('TOKEN_INVALID');
      task = ownerTask;
      conn.token = t.token;
      this.deps.log.info('ws.auth', { taskId: t.taskId, token: hashToken(t.token) });
    }
    conn.taskId = task.taskId;
    this.send(conn, {
      type: 'auth_ok',
      taskId: task.taskId,
      state: task.state,
      preset: task.preset,
      cells: this.deps.runtime.cellsSnapshot(task),
    });
  }

  /** viewer 写指令确定性拒绝（只读分享，先于任何令牌/状态校验） */
  private rejectIfViewer(conn: Conn): void {
    if (conn.role === 'viewer') throw new GatewayError('READONLY', '只读分享不可执行该操作');
  }

  /** 每条指令前重新校验令牌（吊销/作废即时生效） */
  private freshTask(conn: Conn) {
    if (!conn.token || !conn.taskId) throw new GatewayError('TOKEN_INVALID', '未登录');
    const t = requireToken(this.deps.tokens, conn.token);
    const task = this.deps.runtime.get(t.taskId);
    if (!task) throw new GatewayError('TOKEN_INVALID');
    return task;
  }

  private handleCommand(conn: Conn, msg: Extract<Uplink, { type: 'command' }>): void {
    this.rejectIfViewer(conn);
    const task = this.freshTask(conn);
    const plan = this.deps.validator.validateCommand(task, msg);
    this.deps.log.info('ws.command', { taskId: task.taskId, kind: plan.kind, cellId: plan.kind === 'modify' ? plan.cellId : undefined });
    if (plan.kind === 'first') {
      void this.deps.runtime.executeFirst(task, plan).catch((err) => {
        this.deps.log.error('runtime.first.failed', { taskId: task.taskId, err: String(err) });
        this.send(conn, { type: 'error', code: 'DSH_FAILED', retryable: true, message: String(err) });
      });
    } else {
      void this.deps.runtime.executeModify(task, plan).catch((err) => {
        if (err instanceof GatewayError) {
          this.send(conn, { type: 'error', code: err.code, cellId: err.cellId, retryable: false, message: err.message });
        } else {
          this.deps.log.error('runtime.modify.failed', { taskId: task.taskId, err: String(err) });
          this.send(conn, { type: 'error', code: 'DSH_FAILED', retryable: true, message: String(err) });
        }
      });
    }
  }

  private handleConfirm(conn: Conn, satisfaction: unknown): void {
    this.rejectIfViewer(conn);
    const task = this.freshTask(conn);
    const value = this.deps.validator.validateConfirm(task, satisfaction);
    if (conn.token) this.deps.tokens.setState(conn.token, 'USED');
    this.deps.runtime.confirm(task, value);
  }
}
