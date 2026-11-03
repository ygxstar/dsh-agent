/** 兑换得到的令牌列表：暂存 localStorage，供进入工作台时 auth（frontend-design §1） */

export interface StoredToken {
  token: string;
  taskId: string;
}

const KEY = 'dsh.tokens';

export function loadTokens(): StoredToken[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is StoredToken =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as StoredToken).token === 'string' &&
        typeof (t as StoredToken).taskId === 'string',
    );
  } catch {
    return [];
  }
}

export function saveTokens(list: StoredToken[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
}

/** 合并去重（同码可重复领取） */
export function mergeTokens(incoming: StoredToken[]): StoredToken[] {
  const existing = loadTokens();
  const seen = new Set(existing.map((t) => t.token));
  for (const t of incoming) {
    if (!seen.has(t.token)) {
      existing.push(t);
      seen.add(t.token);
    }
  }
  saveTokens(existing);
  return existing;
}

export function removeToken(token: string): void {
  saveTokens(loadTokens().filter((t) => t.token !== token));
}

export function tokenForTask(taskId: string): StoredToken | undefined {
  return loadTokens().find((t) => t.taskId === taskId);
}
