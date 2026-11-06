import type { CellSnapshot, Preset, SkillManifest, TaskState } from './types';

/** HTTP 封装（frontend-design §2 api/client）；错误一律抛 ApiError(code) */

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (!res.ok) {
    const code = typeof data.error === 'string' ? data.error : `HTTP_${res.status}`;
    throw new ApiError(code, typeof data.message === 'string' ? data.message : undefined);
  }
  return data as T;
}

export interface RedeemResult {
  tokens: Array<{ token: string; taskId: string }>;
}

export async function redeem(code: string): Promise<RedeemResult> {
  return request('/redeem', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
}

export async function fetchSkills(): Promise<SkillManifest[]> {
  return request('/skills');
}

/** multipart 上传；网关要求 Bearer 令牌（gateway-interface §4.1） */
export async function upload(file: File, token: string): Promise<{ imageRef: string }> {
  const fd = new FormData();
  fd.append('file', file);
  return request('/upload', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: fd,
  });
}

export function fileUrl(ref: string): string {
  return `/files/${encodeURIComponent(ref)}`;
}

/** /auth 快照（owner tk_* 与只读 sh* 两通道同构，ADR-0008） */
export interface AuthSnapshot {
  taskId: string;
  state: TaskState;
  preset: Preset;
  cells: CellSnapshot[];
}

/** 只读通道：凭 sh_* + taskId 取任务快照，不校验 tk_*；sh 无效/撤销/任务过期 → 403 SHARE_INVALID */
export async function shareAuth(sh: string, taskId: string): Promise<AuthSnapshot> {
  return request('/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sh, taskId }),
  });
}

export interface ShareStatus {
  taskId: string;
  shared: boolean;
  sh?: string;
}

/** 签发/轮换分享令牌（owner，重复调用即轮换、旧 sh 立即失效） */
export async function createShare(token: string, taskId: string): Promise<ShareStatus> {
  return request(`/task/${encodeURIComponent(taskId)}/share`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
}

/** 当前分享状态（owner，回显分享链接用） */
export async function getShare(token: string, taskId: string): Promise<ShareStatus> {
  return request(`/task/${encodeURIComponent(taskId)}/share`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** 停止分享（owner，幂等；撤销后旧链接下一次请求即 403） */
export async function revokeShare(token: string, taskId: string): Promise<ShareStatus> {
  return request(`/task/${encodeURIComponent(taskId)}/share`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
}
