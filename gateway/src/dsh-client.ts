import { randomUUID } from 'node:crypto';
import { GatewayError } from './types.js';

/** dsh-webapi 技能清单条目（gateway-interface §3） */
export interface SkillManifest {
  id: string;
  displayName: string;
  kind: 'txt2img' | 'img2img';
  requiresSourceImage: boolean;
  paramsSchema: Record<string, unknown>;
}

export interface SessionFile {
  path: string;
  size: number;
  /** 真实 dsh-webapi 目录浏览条目会带 dir；桩不带（默认按文件处理） */
  type?: 'file' | 'dir';
}

export interface PromptBody {
  prompt: string;
  stallTimeoutMs: number;
}

/** 网关对 dsh-webapi 的唯一出口（backend-design §2 dsh-client）；测试注入 fake */
export interface DshClient {
  createSession(): Promise<string>;
  getSkills(): Promise<SkillManifest[]>;
  systemStatus(): Promise<Record<string, unknown>>;
  /** SSE 流式执行；onDelta 逐段转发；停滞超时抛 DSH_TIMEOUT，执行失败抛 DSH_FAILED */
  promptStream(sessionId: string, body: PromptBody, onDelta: (delta: string) => void): Promise<void>;
  /** 列出会话工作区文件；subdir 为相对工作区的子目录（真实 dsh-webapi 支持 ?path= 逐层浏览） */
  listFiles(sessionId: string, subdir?: string): Promise<SessionFile[]>;
  /** 上传文件到会话工作区，返回工作区相对路径 */
  uploadFile(sessionId: string, filename: string, data: Buffer, mime: string): Promise<string>;
  downloadFile(sessionId: string, path: string): Promise<Buffer>;
  cancelSession(sessionId: string): Promise<void>;
}

export class HttpDshClient implements DshClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, ...extra };
  }

  /** 真实 dsh-webapi 包一层 { ok, data, timestamp }；桩返回裸对象/数组——统一取内层 */
  private async unwrapJson(res: Response): Promise<unknown> {
    const raw = (await res.json()) as unknown;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const rec = raw as Record<string, unknown>;
      if ('ok' in rec && 'data' in rec) return rec.data;
    }
    return raw;
  }

  private async req(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.headers(init.headers as Record<string, string>),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GatewayError('DSH_FAILED', `dsh ${init.method ?? 'GET'} ${path} → ${res.status} ${text.slice(0, 200)}`);
    }
    return res;
  }

  async createSession(): Promise<string> {
    const sessionId = `sess-${randomUUID().slice(0, 12)}`;
    // 真实 dsh-webapi 会话默认 cwd 为 '/'，其 safeJoin 对根目录恒判越界导致下载 400；
    // 为每会话指定独立工作区（gateway-interface §5 会话工作区约定）
    const res = await this.req('/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, cwd: `/root/.dsh/staging/${sessionId}` }),
    });
    const data = (await this.unwrapJson(res)) as Record<string, unknown>;
    const id = (data.id ?? data.sessionId) as string | undefined;
    if (!id) throw new GatewayError('DSH_FAILED', 'dsh /sessions 未返回会话 id');
    return id;
  }

  async getSkills(): Promise<SkillManifest[]> {
    const res = await this.req('/skills');
    const data = await this.unwrapJson(res);
    const arr = Array.isArray(data) ? data : ((data as { skills?: unknown[] }).skills ?? []);
    return (arr as Record<string, unknown>[]).map((s) => ({
      id: String(s.id ?? s.name ?? ''),
      displayName: String(s.displayName ?? s.title ?? s.name ?? s.id ?? ''),
      kind: (s.kind === 'txt2img' ? 'txt2img' : 'img2img') as SkillManifest['kind'],
      requiresSourceImage: s.requiresSourceImage !== false && s.kind !== 'txt2img',
      paramsSchema: (s.paramsSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    })).filter((s) => s.id);
  }

  async systemStatus(): Promise<Record<string, unknown>> {
    const res = await this.req('/system/status');
    return (await this.unwrapJson(res)) as Record<string, unknown>;
  }

  async promptStream(sessionId: string, body: PromptBody, onDelta: (delta: string) => void): Promise<void> {
    const controller = new AbortController();
    let stallTimer: NodeJS.Timeout | undefined;
    const arm = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      // 与 body.stallTimeoutMs 同值：真实 DSH 会先经 SSE 报具体错误，本地兜底负责 stub/静默场景
      stallTimer = setTimeout(() => controller.abort(new GatewayError('DSH_TIMEOUT')), body.stallTimeoutMs);
    };
    arm();
    try {
      const res = await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/prompt-stream`, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json', accept: 'text/event-stream' }),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new GatewayError('DSH_FAILED', `prompt-stream → ${res.status} ${text.slice(0, 200)}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        arm();
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          this.dispatchSseEvent(raw, onDelta);
        }
      }
      if (buf.trim()) this.dispatchSseEvent(buf, onDelta);
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      if ((err as Error).name === 'AbortError') {
        const reason = controller.signal.reason;
        if (reason instanceof GatewayError) throw reason;
        throw new GatewayError('DSH_TIMEOUT');
      }
      throw new GatewayError('DSH_FAILED', (err as Error).message);
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }
  }

  private dispatchSseEvent(raw: string, onDelta: (delta: string) => void): void {
    const lines = raw.split('\n');
    const eventLine = lines.find((l) => l.startsWith('event:'));
    const eventName = eventLine ? eventLine.slice(6).trim() : '';
    const payload = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!payload) return;
    if (payload === '[DONE]') return;
    let obj: Record<string, unknown> | null = null;
    try {
      obj = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      obj = null;
    }
    const type = String(obj?.type ?? eventName ?? '');
    if (type === 'error') throw new GatewayError('DSH_FAILED', String(obj?.message ?? 'dsh 流式错误'));
    if (type === 'done') return;
    if (obj && typeof obj.delta === 'string') return onDelta(obj.delta);
    if (obj && typeof obj.text === 'string') return onDelta(obj.text);
    if (obj && typeof obj.message === 'string' && type === 'progress') return onDelta(obj.message);
    return onDelta(payload);
  }

  async listFiles(sessionId: string, subdir?: string): Promise<SessionFile[]> {
    const qs = subdir ? `?path=${encodeURIComponent(subdir)}` : '';
    const res = await this.req(`/sessions/${encodeURIComponent(sessionId)}/files${qs}`);
    const data = await this.unwrapJson(res);
    const rec = (Array.isArray(data) ? {} : data) as {
      files?: unknown[];
      items?: unknown[];
      entries?: unknown[];
    };
    const arr = Array.isArray(data) ? data : (rec.files ?? rec.items ?? rec.entries ?? []);
    return (arr as Record<string, unknown>[])
      .filter((f) => typeof f.path === 'string')
      .map((f) => ({
        path: String(f.path),
        size: Number(f.size ?? 0),
        ...(f.type === 'dir' ? ({ type: 'dir' } as const) : {}),
      }));
  }

  async uploadFile(sessionId: string, filename: string, data: Buffer, mime: string): Promise<string> {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(data)], { type: mime }), filename);
    const res = await this.req(`/sessions/${encodeURIComponent(sessionId)}/files`, { method: 'POST', body: fd });
    const json = (await this.unwrapJson(res).catch(() => ({}))) as Record<string, unknown>;
    const listed = (json.files as Array<{ path?: string }> | undefined) ?? [];
    const raw = (json.path ?? json.filePath ?? json.name ?? listed[0]?.path ?? filename) as string;
    // 真实上传回绝对路径且 download 只收相对工作区的路径——统一转相对（桩本就返回文件名）
    const cwd = typeof json.cwd === 'string' ? json.cwd : undefined;
    if (cwd && raw.startsWith(`${cwd}/`)) return raw.slice(cwd.length + 1);
    if (raw.includes('/')) return raw.slice(raw.lastIndexOf('/') + 1);
    return raw;
  }

  async downloadFile(sessionId: string, path: string): Promise<Buffer> {
    const res = await this.req(
      `/sessions/${encodeURIComponent(sessionId)}/files/download?path=${encodeURIComponent(path)}`,
    );
    return Buffer.from(await res.arrayBuffer());
  }

  async cancelSession(sessionId: string): Promise<void> {
    await fetch(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/cancel`, {
      method: 'POST',
      headers: this.headers(),
    }).catch(() => undefined);
  }
}
