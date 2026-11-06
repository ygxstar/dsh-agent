import type { ShareEntry, ShareStore } from './share-store.js';
import type { TokenStore } from './token-store.js';
import type { Task, Token } from './types.js';
import { GatewayError } from './types.js';

/** 令牌校验（HTTP /auth、WS auth 与后续每条指令共用） */
export function requireToken(tokens: TokenStore, token: unknown): Token {
  if (typeof token !== 'string' || token.length === 0) throw new GatewayError('TOKEN_INVALID');
  const t = tokens.get(token);
  if (!t) throw new GatewayError('TOKEN_INVALID');
  if (t.state === 'USED') throw new GatewayError('TOKEN_USED');
  if (t.state === 'EXPIRED') throw new GatewayError('TOKEN_EXPIRED');
  if (t.state === 'REVOKED') throw new GatewayError('TOKEN_INVALID');
  return t;
}

/** 403 SHARE_INVALID 统一通用文案：不区分伪造/撤销/不匹配/过期，避免向客户端泄露失败原因 */
const SHARE_INVALID_MSG = '分享令牌无效、已撤销或已过期';

/** 分享令牌校验（WS viewer auth 与 HTTP /auth 的 sh 通道共用）：伪造/撤销/与任务不匹配/任务过期/超分享 TTL → SHARE_INVALID（403） */
export function requireShare(
  shares: ShareStore,
  sh: unknown,
  taskId: unknown,
  runtime: { get(taskId: string): Task | undefined },
  ttlMs: number,
): { entry: ShareEntry; task: Task } {
  if (typeof sh !== 'string' || sh.length === 0) throw new GatewayError('SHARE_INVALID', SHARE_INVALID_MSG);
  const entry = shares.get(sh);
  if (!entry) throw new GatewayError('SHARE_INVALID', SHARE_INVALID_MSG);
  if (Date.now() - entry.createdAt >= ttlMs) {
    // 分享独立 TTL（ADR-0008「随任务 24h TTL」）：任务 sweep 跳过 DONE、任务表不删条目，故过期即删
    shares.revoke(entry.taskId);
    throw new GatewayError('SHARE_INVALID', SHARE_INVALID_MSG);
  }
  if (typeof taskId !== 'string' || taskId.length === 0 || taskId !== entry.taskId) {
    throw new GatewayError('SHARE_INVALID', SHARE_INVALID_MSG);
  }
  const task = runtime.get(entry.taskId);
  if (!task || task.state === 'EXPIRED') {
    shares.revoke(entry.taskId); // 任务已过期：分享随任务同灭，顺带清理条目
    throw new GatewayError('SHARE_INVALID', SHARE_INVALID_MSG);
  }
  return { entry, task };
}

/** 公网写端点 owner 鉴权：sh_* 属只读凭证一律 SHARE_INVALID(403)，其余按登录令牌校验 */
export function requireOwner(tokens: TokenStore, bearer: unknown): Token {
  if (typeof bearer === 'string' && bearer.startsWith('sh_')) {
    throw new GatewayError('SHARE_INVALID', '分享令牌只读，不可执行写操作');
  }
  return requireToken(tokens, bearer);
}
