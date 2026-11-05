import { createGateway, type Gateway } from '../src/app.js';
import { createLogger } from '../src/logger.js';
import type { Config } from '../src/config.js';
import type { DshClient } from '../src/dsh-client.js';
import type { Downlink, Uplink } from '../src/types.js';
import WebSocket from 'ws';

/** 全端口 0 的测试配置；dsh 由各测试注入 fake 或真 stub */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    adminHost: '127.0.0.1',
    adminPort: 0,
    dshBaseUrl: 'http://127.0.0.1:1/api/v1',
    dshApiKey: 'test-key',
    maxConcurrentCells: 3,
    maxPayloadBytes: 256 * 1024,
    maxUploadBytes: 10 * 1024 * 1024,
    commandRateLimit: 30,
    redeemRateLimit: 10,
    stallTimeoutMs: 2000,
    taskTtlMs: 24 * 60 * 60 * 1000,
    salvageIntervalMs: 50,
    staticDir: null,
    ...overrides,
  };
}

export async function startGateway(overrides: Partial<Config> = {}, dsh?: DshClient): Promise<Gateway> {
  const gw = await createGateway({
    config: testConfig(overrides),
    ...(dsh ? { dsh } : {}),
    log: createLogger('error'),
  });
  await gw.start();
  return gw;
}

export interface JsonResult<T = Record<string, unknown>> {
  status: number;
  data: T;
}

export async function json<T = Record<string, unknown>>(
  url: string,
  method = 'POST',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResult<T>> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: T;
  try {
    data = JSON.parse(text) as T;
  } catch {
    data = { raw: text } as unknown as T;
  }
  return { status: res.status, data };
}

/** multipart 上传（FormData 直接给 fetch） */
export async function uploadImage(
  url: string,
  token: string,
  bytes: Uint8Array,
  filename = 'photo.png',
  mime = 'image/png',
): Promise<JsonResult> {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: mime }), filename);
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
  const text = await res.text();
  return { status: res.status, data: JSON.parse(text) as Record<string, unknown> };
}

export interface WsClient {
  ws: WebSocket;
  received: Downlink[];
  send(msg: Uplink): void;
  /** 按谓词等待一条下行（先查已收缓冲；fromIndex 只看该下标之后的事件，避开历史命中） */
  waitFor(pred: (m: Downlink) => boolean, timeoutMs?: number, fromIndex?: number): Promise<Downlink>;
  /** 等待累计收到 n 条下行后返回全部 */
  waitForCount(n: number, timeoutMs?: number): Promise<Downlink[]>;
  close(): void;
}

export async function connectWs(url: string): Promise<WsClient> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const received: Downlink[] = [];
  const waiters: Array<{ pred: (m: Downlink) => boolean; resolve: (m: Downlink) => void; reject: (e: Error) => void }> = [];
  let countWaiters: Array<{ n: number; resolve: (v: Downlink[]) => void }> = [];

  ws.on('message', (raw) => {
    let msg: Downlink;
    try {
      msg = JSON.parse(String(raw)) as Downlink;
    } catch {
      return;
    }
    received.push(msg);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].pred(msg)) {
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
    countWaiters = countWaiters.filter((w) => {
      if (received.length >= w.n) {
        w.resolve([...received]);
        return false;
      }
      return true;
    });
  });

  const failAll = (err: Error): void => {
    for (const w of waiters.splice(0)) w.reject(err);
  };
  ws.on('close', () => failAll(new Error('ws closed')));
  ws.on('error', (err) => failAll(err instanceof Error ? err : new Error(String(err))));

  return {
    ws,
    received,
    send(msg) {
      ws.send(JSON.stringify(msg));
    },
    waitFor(pred, timeoutMs = 8000, fromIndex = 0) {
      const hit = received.slice(fromIndex).find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(
            new Error(
              `waitFor 超时；已收到: ${JSON.stringify(received.map((m) => m.type))}`,
            ),
          );
        }, timeoutMs);
        waiters.push({
          pred,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
      });
    },
    waitForCount(n, timeoutMs = 8000) {
      if (received.length >= n) return Promise.resolve([...received]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`waitForCount(${n}) 超时；已收到 ${received.length}: ${JSON.stringify(received.map((m) => m.type))}`));
        }, timeoutMs);
        countWaiters.push({
          n,
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
        });
      });
    },
    close() {
      ws.close();
    },
  };
}

/** WS 快捷流程：连接 → auth → 等 auth_ok */
export async function authedWs(url: string, token: string): Promise<WsClient> {
  const c = await connectWs(url);
  c.send({ type: 'auth', token });
  await c.waitFor((m) => m.type === 'auth_ok');
  return c;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 轮询直到谓词成立（用于等异步状态落定） */
export async function until(pred: () => boolean, timeoutMs = 8000, stepMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('until 超时');
    await sleep(stepMs);
  }
}
