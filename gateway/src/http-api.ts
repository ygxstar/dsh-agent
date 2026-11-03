import busboy from 'busboy';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import type { Config } from './config.js';
import { requireToken } from './auth.js';
import type { DshClient } from './dsh-client.js';
import type { FileRegistry } from './files.js';
import type { ManifestStore } from './manifest.js';
import type { Logger } from './logger.js';
import type { CodeStore } from './code-store.js';
import type { TaskRuntime } from './task-runtime.js';
import type { TokenStore } from './token-store.js';
import type { Preset, Uplink } from './types.js';
import { GatewayError } from './types.js';
import type { Validator } from './validation.js';

export interface HttpApiDeps {
  config: Config;
  tokens: TokenStore;
  codes: CodeStore;
  runtime: TaskRuntime;
  files: FileRegistry;
  manifest: ManifestStore;
  dsh: DshClient;
  validator: Validator;
  log: Logger;
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/** 托管前端产物的 MIME（图片之外还需 html/css/js 等，否则浏览器按附件下载） */
const STATIC_MIME_BY_EXT: Record<string, string> = {
  ...MIME_BY_EXT,
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof GatewayError) {
    const status =
      err.code.startsWith('TOKEN_') || err.code.startsWith('REDEEM_')
        ? 401
        : err.code === 'PAYLOAD_TOO_LARGE'
          ? 413
          : err.code === 'LIMIT'
            ? 429
            : err.code === 'STATE_INVALID' || err.code === 'IMAGE_REF_INVALID'
              ? 409
              : 400;
    sendJson(res, status, { error: err.code, message: err.message });
    return;
  }
  sendJson(res, 500, { error: 'INTERNAL', message: String(err instanceof Error ? err.message : err) });
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) throw new GatewayError('PAYLOAD_TOO_LARGE');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) throw new GatewayError('BAD_PARAMS', '请求体为空');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GatewayError('BAD_PARAMS', '请求体不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new GatewayError('BAD_PARAMS', '请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

function parseMultipart(
  req: IncomingMessage,
  maxFileBytes: number,
): Promise<{ files: Array<{ filename: string; mime: string; data: Buffer }>; tooLarge: boolean }> {
  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: maxFileBytes, files: 8 } });
    } catch (err) {
      reject(new GatewayError('BAD_PARAMS', '非 multipart 请求'));
      return;
    }
    const files: Array<{ filename: string; mime: string; data: Buffer }> = [];
    let tooLarge = false;
    bb.on('file', (_name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('limit', () => {
        tooLarge = true;
      });
      stream.on('close', () => {
        files.push({ filename: info.filename || 'upload.bin', mime: info.mimeType || 'application/octet-stream', data: Buffer.concat(chunks) });
      });
    });
    bb.on('close', () => resolve({ files, tooLarge }));
    bb.on('error', (err) => reject(err));
    req.pipe(bb);
  });
}

/* ================= 公网路由 ================= */

export function createPublicServer(deps: HttpApiDeps): Server {
  const { config } = deps;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    const path = url.pathname;
    try {
      if (req.method === 'POST' && path === '/redeem') return await handleRedeem(deps, req, res);
      if (req.method === 'POST' && path === '/auth') return await handleAuth(deps, req, res);
      if (req.method === 'GET' && path === '/skills') {
        return sendJson(res, 200, deps.manifest.list());
      }
      if (req.method === 'POST' && path === '/upload') return await handleUpload(deps, req, res);
      if (req.method === 'GET' && path.startsWith('/files/')) return await handleFile(deps, req, res, path.slice('/files/'.length));
      if (req.method === 'GET') return serveStatic(deps, res, path);
      sendJson(res, 404, { error: 'NOT_FOUND' });
    } catch (err) {
      if (!(err instanceof GatewayError)) deps.log.error('http.error', { path, err: String(err) });
      if (!res.headersSent) sendError(res, err);
      else res.end();
    }
  });
  return server;
}

async function handleRedeem(deps: HttpApiDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, deps.config.maxPayloadBytes);
  const code = body.code;
  if (typeof code !== 'string' || code.length === 0) throw new GatewayError('BAD_PARAMS', '缺少 code');
  const record = deps.codes.claim(code, Date.now(), deps.config.redeemRateLimit);
  const tokens = record.tokenRefs
    .map((t) => deps.tokens.get(t))
    .filter((t): t is NonNullable<typeof t> => Boolean(t) && t!.state === 'ACTIVE')
    .map((t) => ({ token: t.token, taskId: t.taskId, preset: deps.runtime.get(t.taskId)?.preset }));
  deps.log.info('redeem.ok', { code: record.code.slice(0, 4) + '***', count: tokens.length });
  sendJson(res, 200, { tokens });
}

async function handleAuth(deps: HttpApiDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, deps.config.maxPayloadBytes);
  const token = requireToken(deps.tokens, body.token);
  const task = deps.runtime.get(token.taskId);
  if (!task) throw new GatewayError('TOKEN_INVALID');
  sendJson(res, 200, {
    taskId: task.taskId,
    state: task.state,
    preset: task.preset,
    cells: deps.runtime.cellsSnapshot(task),
  });
}

async function handleUpload(deps: HttpApiDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = req.headers.authorization;
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : undefined;
  const token = requireToken(deps.tokens, bearer);
  const task = deps.runtime.get(token.taskId);
  if (!task) throw new GatewayError('TOKEN_INVALID');
  if (task.expanded) throw new GatewayError('STATE_INVALID', '首条指令已提交，任务内禁止再传新图');

  const { files, tooLarge } = await parseMultipart(req, deps.config.maxUploadBytes);
  if (tooLarge) throw new GatewayError('PAYLOAD_TOO_LARGE');
  if (files.length === 0) throw new GatewayError('BAD_PARAMS', '未收到文件');
  const image = files.find((f) => f.mime.startsWith('image/'));
  if (!image) throw new GatewayError('BAD_PARAMS', '仅允许图片 MIME');
  if (image.data.length === 0) throw new GatewayError('BAD_PARAMS', '空文件');

  // staging 文件名加随机前缀：同名上传（如都叫 photo.png）不得互相覆盖
  const uniqueName = `src-${randomUUID().slice(0, 8)}${extname(image.filename) || '.bin'}`;
  const path = await deps.dsh.uploadFile(task.stagingSessionId, uniqueName, image.data, image.mime);
  const entry = deps.files.registerSource(task.stagingSessionId, path);
  deps.log.info('upload.ok', { taskId: task.taskId, ref: entry.ref, bytes: image.data.length });
  sendJson(res, 200, { imageRef: entry.ref });
}

async function handleFile(deps: HttpApiDeps, _req: IncomingMessage, res: ServerResponse, ref: string): Promise<void> {
  const entry = deps.files.get(ref);
  if (!entry) throw new GatewayError('IMAGE_REF_INVALID', `未知引用: ${ref}`);
  const data = await deps.dsh.downloadFile(entry.sessionId, entry.path);
  const ext = extname(entry.path).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
    'content-length': data.length,
    'cache-control': 'private, max-age=3600',
  });
  res.end(data);
}

/** 托管前端构建产物；无扩展路径回退 index.html（SPA 路由） */
function serveStatic(deps: HttpApiDeps, res: ServerResponse, path: string): void {
  const root = deps.config.staticDir;
  if (!root || !existsSync(root)) {
    sendJson(res, 404, { error: 'NOT_FOUND', message: '网关未托管前端静态页' });
    return;
  }
  const rel = normalize(path).replace(/^([/\\])+/, '');
  let file = join(root, rel);
  if (!file.startsWith(root)) {
    sendJson(res, 400, { error: 'BAD_PARAMS' });
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(rel)) {
      sendJson(res, 404, { error: 'NOT_FOUND' });
      return;
    }
    file = join(root, 'index.html');
  }
  if (!existsSync(file)) {
    sendJson(res, 404, { error: 'NOT_FOUND' });
    return;
  }
  const type = STATIC_MIME_BY_EXT[extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  createReadStream(file).pipe(res);
}

/* ================= 内网管理路由 ================= */

export function createAdminServer(deps: HttpApiDeps): Server {
  const { config } = deps;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    const path = url.pathname;
    try {
      if (req.method === 'POST' && path === '/admin/tokens') return await handleIssue(deps, req, res);
      if (req.method === 'GET' && path === '/admin/tokens') return handleList(deps, res);
      if (req.method === 'DELETE' && path.startsWith('/admin/tokens/')) {
        return handleRevokeToken(deps, res, decodeURIComponent(path.slice('/admin/tokens/'.length)));
      }
      if (req.method === 'POST' && path.startsWith('/admin/codes/') && path.endsWith('/revoke')) {
        const code = decodeURIComponent(path.slice('/admin/codes/'.length, -'/revoke'.length));
        return handleRevokeCode(deps, res, code);
      }
      sendJson(res, 404, { error: 'NOT_FOUND' });
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
      else res.end();
    }
  });
}

function buildPreset(raw: unknown, manifest: ManifestStore): Preset {
  const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const allIds = manifest.list().map((s) => s.id);
  const allowed = Array.isArray(p.allowedSkillIds)
    ? (p.allowedSkillIds as unknown[]).filter((id): id is string => typeof id === 'string' && allIds.includes(id))
    : allIds;
  return {
    allowedSkillIds: allowed,
    maxCells: typeof p.maxCells === 'number' && Number.isInteger(p.maxCells) && p.maxCells > 0 ? Math.min(p.maxCells, 64) : 12,
    params: typeof p.params === 'object' && p.params !== null && !Array.isArray(p.params) ? (p.params as Record<string, unknown>) : {},
    text: typeof p.text === 'string' ? p.text : '',
  };
}

async function handleIssue(deps: HttpApiDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, deps.config.maxPayloadBytes);
  const orderRef = body.orderRef;
  const tasksRaw = body.tasks;
  const expiresAt = body.codeExpiresAt;
  if (typeof orderRef !== 'string' || orderRef.length === 0) throw new GatewayError('BAD_PARAMS', '缺少 orderRef');
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) throw new GatewayError('BAD_PARAMS', 'tasks 至少一项');
  if (tasksRaw.length > 64) throw new GatewayError('LIMIT', '单次签发任务数超限');
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new GatewayError('BAD_PARAMS', 'codeExpiresAt 须为未来时间戳');
  }

  const created = [];
  for (const presetRaw of tasksRaw) {
    const preset = buildPreset(presetRaw, deps.manifest);
    const task = await deps.runtime.createTask({ orderRef, codeRef: null, preset });
    const token = deps.tokens.create(task.taskId, orderRef, null);
    created.push({ task, token });
  }
  const code = deps.codes.create(orderRef, expiresAt, created.map((c) => c.token.token));
  for (const { task, token } of created) {
    task.codeRef = code.code;
    token.codeRef = code.code; // 回填：吊销收货码靠 token.codeRef 联动找出未用令牌
  }
  deps.log.info('tokens.issued', { orderRef, count: created.length, code: code.code.slice(0, 4) + '***', expiresAt });
  sendJson(res, 200, {
    redeemCode: code.code,
    expiresAt,
    tokens: created.map((c) => ({ token: c.token.token, taskId: c.task.taskId })),
  });
}

function handleList(deps: HttpApiDeps, res: ServerResponse): void {
  const tokens = deps.tokens.list().map((t) => ({
    token: t.token,
    taskId: t.taskId,
    state: t.state,
    orderRef: t.orderRef,
    codeRef: t.codeRef,
    taskState: deps.runtime.get(t.taskId)?.state ?? null,
    createdAt: t.createdAt,
  }));
  sendJson(res, 200, { tokens });
}

function handleRevokeToken(deps: HttpApiDeps, res: ServerResponse, token: string): void {
  const t = deps.tokens.get(token);
  if (!t) throw new GatewayError('TOKEN_INVALID');
  if (t.state === 'ACTIVE') t.state = 'REVOKED';
  deps.log.info('token.revoked', { taskId: t.taskId });
  sendJson(res, 200, { ok: true, state: t.state });
}

function handleRevokeCode(deps: HttpApiDeps, res: ServerResponse, code: string): void {
  const ok = deps.codes.revoke(code);
  if (!ok) throw new GatewayError('REDEEM_INVALID');
  let revoked = 0;
  for (const t of deps.tokens.listByCode(code)) {
    if (t.state === 'ACTIVE') {
      t.state = 'REVOKED';
      revoked += 1;
    }
  }
  deps.log.info('code.revoked', { code: code.slice(0, 4) + '***', revoked });
  sendJson(res, 200, { ok: true, revokedTokens: revoked });
}

/** 供 ws-server 与测试复用的上行消息类型守卫（放这里避免循环依赖） */
export type { Uplink };
