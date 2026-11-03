import { TOKEN_ERROR_CODES } from './errors';
import type { Downlink, Uplink } from './types';

/** WS 客户端（frontend-design §4：auth 握手、30s 心跳、指数退避重连、快照覆盖） */

export type WsStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface WsHandlers {
  onMessage: (m: Downlink) => void;
  onStatus: (s: WsStatus) => void;
  /** 令牌类错误：已停止重连，调用方清本地令牌并回兑换页 */
  onTokenFatal: (code: string) => void;
}

const PING_INTERVAL_MS = 30_000;
const PONG_DEADLINE_MS = 35_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export class TaskWs {
  private ws: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private lastAlive = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly token: string,
    private readonly handlers: WsHandlers,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close();
    this.ws = null;
    this.handlers.onStatus('closed');
  }

  send(msg: Uplink): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  private connect(): void {
    if (this.stopped) return;
    this.handlers.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    this.lastAlive = Date.now();

    ws.onopen = () => {
      this.attempt = 0;
      this.lastAlive = Date.now();
      this.send({ type: 'auth', token: this.token });
      this.startHeartbeat();
      this.handlers.onStatus('open');
    };

    ws.onmessage = (ev: MessageEvent<string>) => {
      let msg: Downlink;
      try {
        msg = JSON.parse(ev.data) as Downlink;
      } catch {
        return;
      }
      this.lastAlive = Date.now();
      if (msg.type === 'error' && TOKEN_ERROR_CODES.has(msg.code)) {
        // 令牌已作废：停止重连，交调用方清令牌回兑换页
        this.stopped = true;
        this.clearTimers();
        ws.close();
        this.handlers.onTokenFatal(msg.code);
        return;
      }
      this.handlers.onMessage(msg);
    };

    ws.onclose = () => {
      this.clearTimers();
      if (this.stopped) return;
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
      this.attempt += 1;
      setTimeout(() => this.connect(), delay);
    };

    ws.onerror = () => {
      /* onclose 统一处理重连 */
    };
  }

  private startHeartbeat(): void {
    this.clearTimers();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastAlive > PONG_DEADLINE_MS) {
        // 心跳超时视为断线：强制关闭触发重连
        this.ws?.close();
        return;
      }
      this.send({ type: 'ping' });
    }, PING_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
