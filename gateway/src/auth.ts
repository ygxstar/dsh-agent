import type { TokenStore } from './token-store.js';
import type { Token } from './types.js';
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
