import { randomBytes } from 'node:crypto';
import type { Token, TokenState } from './types.js';

/** 令牌 1:1 任务（backend-design §3），仅内存 */
export class TokenStore {
  private readonly tokens = new Map<string, Token>();

  create(taskId: string, orderRef: string, codeRef: string | null, now = Date.now()): Token {
    const token = `tk_${randomBytes(18).toString('base64url')}`;
    const record: Token = { token, taskId, state: 'ACTIVE', createdAt: now, orderRef, codeRef };
    this.tokens.set(token, record);
    return record;
  }

  get(token: string): Token | undefined {
    return this.tokens.get(token);
  }

  setState(token: string, state: TokenState): void {
    const t = this.tokens.get(token);
    if (t) t.state = state;
  }

  list(): Token[] {
    return [...this.tokens.values()];
  }

  /** 令牌列表（管理端） */
  listByCode(code: string): Token[] {
    return [...this.tokens.values()].filter((t) => t.codeRef === code);
  }
}
