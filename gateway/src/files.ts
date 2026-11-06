import { randomBytes } from 'node:crypto';

export type FileKind = 'source' | 'output';

export interface FileEntry {
  ref: string;
  /** 源图指向 staging 会话，产出图指向格会话 */
  sessionId: string;
  path: string;
  cellId: string | null;
  kind: FileKind;
}

function genRef(prefix: 'img' | 'out'): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

/** imageRef → (sessionId, path) 映射表：源图与产出图同一张表（backend-design §3） */
export class FileRegistry {
  private readonly byRef = new Map<string, FileEntry>();

  registerSource(sessionId: string, path: string): FileEntry {
    const entry: FileEntry = { ref: genRef('img'), sessionId, path, cellId: null, kind: 'source' };
    this.byRef.set(entry.ref, entry);
    return entry;
  }

  registerOutput(sessionId: string, path: string, cellId: string): FileEntry {
    const entry: FileEntry = { ref: genRef('out'), sessionId, path, cellId, kind: 'output' };
    this.byRef.set(entry.ref, entry);
    return entry;
  }

  get(ref: string): FileEntry | undefined {
    return this.byRef.get(ref);
  }

  /** 该格已登记的产出引用 */
  outputsOf(cellId: string): string[] {
    return [...this.byRef.values()].filter((e) => e.cellId === cellId && e.kind === 'output').map((e) => e.ref);
  }

  /** 该会话下已登记的工作区路径：产出差量判重按会话而非 cellId——cellId 只在任务内唯一，
   *  不同任务的同名格（如都有 cell_01）在不同会话产出同名文件时会互相误判为已登记 */
  pathsOfSession(sessionId: string): Set<string> {
    return new Set([...this.byRef.values()].filter((e) => e.sessionId === sessionId).map((e) => e.path));
  }

  /** 该任务（staging 会话）下已登记的源图引用 */
  sourcesOfSession(sessionId: string): string[] {
    return [...this.byRef.values()].filter((e) => e.sessionId === sessionId && e.kind === 'source').map((e) => e.ref);
  }
}
