import type { SkillManifest } from './types';

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
