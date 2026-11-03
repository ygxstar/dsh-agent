import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { requireToken } from './auth.js';
import type { HttpApiDeps } from './http-api.js';
import type { Downlink, Uplink } from './types.js';
import { GatewayError } from './types.js';

interface Conn {
  ws: WebSocket;
  token?: string;
  taskId?: string;
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

  /** 任务事件广播到该任务的全部连接（同令牌多标签页） */
  broadcast(taskId: string, event: Downlink): void {
    const data = JSON.stringify(event);
    for (const conn of this.conns) {
      if (conn.taskId === taskId && conn.ws.readyState === WebSocket.OPEN) conn.ws.send(data);
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
    try {
      switch (msg.type) {
        case 'auth':
          this.handleAuth(conn, msg.token);
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

  private handleAuth(conn: Conn, token: unknown): void {
    if (conn.taskId) throw new GatewayError('STATE_INVALID', '连接已登录');
    const t = requireToken(this.deps.tokens, token);
    const task = this.deps.runtime.get(t.taskId);
    if (!task) throw new GatewayError('TOKEN_INVALID');
    conn.token = t.token;
    conn.taskId = t.taskId;
    this.deps.log.info('ws.auth', { taskId: t.taskId, token: t.token.slice(0, 6) + '***' });
    this.send(conn, {
      type: 'auth_ok',
      taskId: task.taskId,
      state: task.state,
      preset: task.preset,
      cells: this.deps.runtime.cellsSnapshot(task),
    });
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
    const task = this.freshTask(conn);
    const value = this.deps.validator.validateConfirm(task, satisfaction);
    if (conn.token) this.deps.tokens.setState(conn.token, 'USED');
    this.deps.runtime.confirm(task, value);
  }
}
