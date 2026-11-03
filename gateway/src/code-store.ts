import { randomInt } from 'node:crypto';
import type { RedeemCode } from './types.js';
import { GatewayError } from './types.js';

/** 无歧义字符集（去 0/O/1/I/L） */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function genCode(len = 8): string {
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

/** 收货码：1:N 令牌、有效期、吊销、单码领取限频（backend-design §3/§7） */
export class CodeStore {
  private readonly codes = new Map<string, RedeemCode>();

  create(orderRef: string, expiresAt: number, tokenRefs: string[]): RedeemCode {
    let code = genCode();
    while (this.codes.has(code)) code = genCode();
    const record: RedeemCode = {
      code,
      orderRef,
      expiresAt,
      state: 'ACTIVE',
      claimCount: 0,
      tokenRefs,
      claimTimes: [],
    };
    this.codes.set(code, record);
    return record;
  }

  get(code: string): RedeemCode | undefined {
    return this.codes.get(code);
  }

  revoke(code: string): boolean {
    const c = this.codes.get(code);
    if (!c) return false;
    c.state = 'REVOKED';
    return true;
  }

  /**
   * 收货码管道（backend-design §7）：存在 → 未过期 → 未吊销 → 限频。
   * 任一步失败抛 REDEEM_* / LIMIT，成功返回码记录。
   */
  claim(code: string, now = Date.now(), rateLimit = 10, windowMs = 60_000): RedeemCode {
    const c = this.codes.get(code);
    if (!c) throw new GatewayError('REDEEM_INVALID');
    if (c.expiresAt <= now) throw new GatewayError('REDEEM_EXPIRED');
    if (c.state === 'REVOKED') throw new GatewayError('REDEEM_REVOKED');
    c.claimTimes = c.claimTimes.filter((t) => now - t < windowMs);
    if (c.claimTimes.length >= rateLimit) throw new GatewayError('LIMIT');
    c.claimTimes.push(now);
    c.claimCount += 1;
    return c;
  }
}
