import { randomBytes } from 'node:crypto';

/** 任务只读分享令牌（ADR-0008）：单任务至多一个有效，重新分享即轮换，仅内存、随任务过期 */
export interface ShareEntry {
  token: string;
  taskId: string;
  createdAt: number;
}

export class ShareStore {
  /** token → 条目；taskId → 当前有效 token（轮换时据此撤销旧令牌） */
  private readonly byToken = new Map<string, ShareEntry>();
  private readonly tokenByTask = new Map<string, string>();

  /** 签发/轮换：同任务旧分享令牌立即失效，返回新令牌 */
  create(taskId: string, now = Date.now()): ShareEntry {
    this.revoke(taskId);
    const token = `sh_${randomBytes(18).toString('base64url')}`;
    const entry: ShareEntry = { token, taskId, createdAt: now };
    this.byToken.set(token, entry);
    this.tokenByTask.set(taskId, token);
    return entry;
  }

  get(token: string): ShareEntry | undefined {
    return this.byToken.get(token);
  }

  getByTask(taskId: string): ShareEntry | undefined {
    const token = this.tokenByTask.get(taskId);
    return token ? this.byToken.get(token) : undefined;
  }

  /** 停止分享：删除该任务当前条目；返回是否确有条目被撤销 */
  revoke(taskId: string): boolean {
    const token = this.tokenByTask.get(taskId);
    if (!token) return false;
    this.tokenByTask.delete(taskId);
    this.byToken.delete(token);
    return true;
  }
}
