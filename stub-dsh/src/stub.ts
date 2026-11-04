import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename } from 'node:path';
import busboy from 'busboy';
import { makePosterPng } from './png.js';

/**
 * dsh-webapi 行为桩（gateway-interface §5 端点映射的最小实现）：
 * Bearer 鉴权 + 会话/文件/SSE prompt-stream，供网关单测与前后台联调注入。
 */

export type StubMode = 'ok' | 'fail' | 'stall';

export interface StubOptions {
  /** 0 = 随机端口（默认），联调时给 3080 */
  port?: number;
  host?: string;
  /** 须与网关 DSH_WEB_API_KEY 一致（默认 stub-secret） */
  apiKey?: string;
  /** 全局 prompt-stream 行为（默认 ok；可运行中切换） */
  mode?: StubMode;
  /** 每段 delta 之间的延迟（毫秒，默认 0） */
  delayMs?: number;
  /** 这些技能的 prompt-stream 直接 500 —— 用于失败隔离测试 */
  failSkills?: string[];
  /** GET /skills 返回体（默认与网关 STATIC_MANIFEST 同构的六技能） */
  skills?: unknown[];
}

export interface StubDsh {
  /** 形如 http://127.0.0.1:3080/api/v1，可直接给网关 DSH_BASE_URL */
  readonly baseUrl: string;
  readonly port: number;
  mode: StubMode;
  setFailSkills(ids: string[]): void;
  sessionCount(): number;
  close(): Promise<void>;
}

const DEFAULT_SKILLS = [
  'mono-color',
  'paperworldphoto',
  'photo-story',
  'real-qgraffiti-illusion',
  'second-world-poster',
  'western-animation-concept-portrait',
].map((id) => ({
  id,
  displayName: id,
  kind: 'img2img',
  requiresSourceImage: true,
  paramsSchema: {
    type: 'object',
    properties: { title: { type: 'string', maxLength: 40, description: '标题' } },
    required: ['title'],
  },
}));

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

interface Session {
  files: Map<string, Buffer>;
  cancelled: boolean;
  seq: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve(typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

/** 拒绝路径穿越与绝对路径（桩只用内存工作区，路径即文件名） */
function safePath(p: string): string | null {
  if (!p) return null;
  const norm = p.replace(/\\/g, '/');
  if (norm.includes('..') || norm.startsWith('/')) return null;
  return norm;
}

export async function createStubDsh(opts: StubOptions = {}): Promise<StubDsh> {
  const apiKey = opts.apiKey ?? 'stub-secret';
  const delayMs = opts.delayMs ?? 0;
  const skills = opts.skills ?? DEFAULT_SKILLS;
  const failSkills = new Set(opts.failSkills ?? []);
  let mode: StubMode = opts.mode ?? 'ok';

  const sessions = new Map<string, Session>();
  const openResponses = new Set<ServerResponse>();
  let sessionSeq = 0;

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: 'STUB_ERROR', message: String(err) });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://stub');
    const path = url.pathname;
    if (!path.startsWith('/api/v1')) {
      sendJson(res, 404, { error: 'NOT_FOUND' });
      return;
    }
    // 鉴权：仅 /api/v1 下的路由，Bearer 必须匹配
    if (req.headers.authorization !== `Bearer ${apiKey}`) {
      sendJson(res, 401, { error: 'UNAUTHORIZED', message: 'missing or invalid api key' });
      return;
    }
    const rel = path.slice('/api/v1'.length);

    if (req.method === 'GET' && rel === '/system/status') {
      sendJson(res, 200, { status: 'ok', service: 'dsh-webapi-stub', mode, uptimeMs: Math.round(process.uptime() * 1000) });
      return;
    }
    if (req.method === 'GET' && rel === '/skills') {
      sendJson(res, 200, { skills });
      return;
    }
    if (req.method === 'POST' && rel === '/sessions') {
      await readJsonBody(req);
      sessionSeq += 1;
      const id = `sess_${sessionSeq}_${Math.random().toString(36).slice(2, 8)}`;
      sessions.set(id, { files: new Map(), cancelled: false, seq: 0 });
      sendJson(res, 200, { id, sessionId: id });
      return;
    }

    const m = rel.match(/^\/sessions\/([^/]+)(\/.*)?$/);
    if (!m) {
      sendJson(res, 404, { error: 'NOT_FOUND' });
      return;
    }
    const sessionId = decodeURIComponent(m[1]);
    const rest = m[2] ?? '';
    const session = sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'SESSION_NOT_FOUND' });
      return;
    }

    if (req.method === 'POST' && rest === '/prompt-stream') {
      await handlePromptStream(req, res, session);
      return;
    }
    if (req.method === 'GET' && rest === '/files') {
      sendJson(res, 200, {
        files: [...session.files.entries()].map(([p, buf]) => ({ path: p, size: buf.length })),
      });
      return;
    }
    if (req.method === 'POST' && rest === '/files') {
      await handleUpload(req, res, session);
      return;
    }
    if (req.method === 'GET' && rest === '/files/download') {
      const p = safePath(url.searchParams.get('path') ?? '');
      const data = p ? session.files.get(p) : undefined;
      if (!data) {
        sendJson(res, 404, { error: 'FILE_NOT_FOUND' });
        return;
      }
      const ext = (p ?? '').slice((p ?? '').lastIndexOf('.')).toLowerCase();
      res.writeHead(200, { 'content-type': MIME_BY_EXT[ext] ?? 'application/octet-stream', 'content-length': data.length });
      res.end(data);
      return;
    }
    if (req.method === 'POST' && rest === '/cancel') {
      session.cancelled = true;
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { error: 'NOT_FOUND' });
  }

  /** SSE 三种行为：ok 流 delta 并落一张海报；fail 500；stall 只握手不发数据 */
  async function handlePromptStream(req: IncomingMessage, res: ServerResponse, session: Session): Promise<void> {
    const body = await readJsonBody(req);
    if (session.cancelled) {
      sendJson(res, 409, { error: 'SESSION_CANCELLED' });
      return;
    }

    let promptText = typeof body.prompt === 'string' ? body.prompt : '';
    let parsed: Record<string, unknown> = {};
    try {
      const v = JSON.parse(promptText) as unknown;
      if (typeof v === 'object' && v !== null) parsed = v as Record<string, unknown>;
    } catch {
      /* 非 JSON prompt 也接受 */
    }
    const skill = String(parsed.skill ?? '');

    if (mode === 'fail' || failSkills.has(skill)) {
      sendJson(res, 500, { error: 'stub: prompt-stream failure', skill });
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    openResponses.add(res);
    let closed = false;
    req.on('close', () => {
      closed = true;
      openResponses.delete(res);
    });

    if (mode === 'stall') {
      // 已握手但永不发数据：网关停滞看门应触发 DSH_TIMEOUT
      return;
    }

    const send = (obj: Record<string, unknown>): void => {
      if (closed || res.writableEnded || res.destroyed) return;
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      } catch {
        closed = true;
      }
    };

    const deltas = [`收到指令，使用技能 ${skill || 'unknown'}。`, '分析参考图与参数…', '生成海报中…'];
    for (const delta of deltas) {
      if (delayMs > 0) await sleep(delayMs);
      if (closed) return;
      send({ type: 'delta', delta });
    }
    if (delayMs > 0) await sleep(delayMs);
    if (closed) return;

    // 产出一张可肉眼区分的海报位图（seed 含 skill/params/text/editTarget，差异配色）
    session.seq += 1;
    const name = `out-${String(session.seq).padStart(2, '0')}.png`;
    const seed = JSON.stringify({ skill, params: parsed.params, text: parsed.text, editTarget: parsed.editTarget, n: session.seq });
    session.files.set(name, makePosterPng(seed));
    send({ type: 'done', outputs: [name] });
    if (!res.writableEnded && !res.destroyed) {
      try {
        res.write('data: [DONE]\n\n');
        res.end();
      } catch {
        /* 客户端已断开 */
      }
    }
    openResponses.delete(res);
  }

  async function handleUpload(req: IncomingMessage, res: ServerResponse, session: Session): Promise<void> {
    const { files, tooLarge } = await new Promise<{
      files: Array<{ filename: string; data: Buffer }>;
      tooLarge: boolean;
    }>((resolve, reject) => {
      let bb: ReturnType<typeof busboy>;
      try {
        bb = busboy({ headers: req.headers, limits: { fileSize: 20 * 1024 * 1024, files: 4 } });
      } catch (err) {
        reject(err);
        return;
      }
      const out: Array<{ filename: string; data: Buffer }> = [];
      let large = false;
      bb.on('file', (_n, stream, info) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('limit', () => {
          large = true;
        });
        stream.on('close', () => {
          out.push({ filename: info.filename || 'upload.bin', data: Buffer.concat(chunks) });
        });
      });
      bb.on('close', () => resolve({ files: out, tooLarge: large }));
      bb.on('error', reject);
      req.pipe(bb);
    });

    if (tooLarge) {
      sendJson(res, 413, { error: 'FILE_TOO_LARGE' });
      return;
    }
    if (files.length === 0) {
      sendJson(res, 400, { error: 'NO_FILE' });
      return;
    }
    const first = files[0];
    const name = basename(first.filename).replace(/[/\\]/g, '_') || 'upload.bin';
    session.files.set(name, first.data);
    sendJson(res, 200, { path: name, size: first.data.length });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const host = opts.host ?? '127.0.0.1';

  return {
    baseUrl: `http://${host}:${port}/api/v1`,
    port,
    get mode() {
      return mode;
    },
    set mode(next: StubMode) {
      mode = next;
    },
    setFailSkills(ids: string[]) {
      failSkills.clear();
      for (const id of ids) failSkills.add(id);
    },
    sessionCount() {
      return sessions.size;
    },
    async close() {
      for (const r of openResponses) r.destroy();
      openResponses.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
