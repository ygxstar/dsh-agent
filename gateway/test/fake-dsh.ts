import { GatewayError } from '../src/types.js';
import type { DshClient, PromptBody, SessionFile, SkillManifest } from '../src/dsh-client.js';
import { STATIC_MANIFEST } from '../src/manifest.js';

/**
 * 注入式 fake DSH：可按技能指定失败/挂起、记录收到的 prompt，
 * 并在 prompt-stream 后向会话落一张假产出图（供差量登记测试）。
 */
export class FakeDsh implements DshClient {
  readonly prompts: Array<{ sessionId: string; body: PromptBody }> = [];
  readonly sessions = new Map<string, Map<string, Buffer>>();
  readonly cancelled: string[] = [];
  /** 这些技能的 promptStream 抛 DSH_FAILED */
  readonly failSkills = new Set<string>();
  /** 每段 delta 间延迟（毫秒），用于制造 RUNNING 窗口 */
  deltaMs = 0;
  /** 挂起的技能 → release() 后才继续 */
  private readonly holds = new Map<string, Array<() => void>>();
  private readonly heldSkills = new Set<string>();
  private sessionSeq = 0;
  private outputSeq = new Map<string, number>();
  /** 额外的产出图片（测试可塞入模拟 DSH 中途生成的新图） */
  extraOutputs = new Map<string, string[]>();

  async createSession(): Promise<string> {
    this.sessionSeq += 1;
    const id = `fake_sess_${this.sessionSeq}`;
    this.sessions.set(id, new Map());
    this.outputSeq.set(id, 0);
    return id;
  }

  async getSkills(): Promise<SkillManifest[]> {
    return STATIC_MANIFEST;
  }

  async systemStatus(): Promise<Record<string, unknown>> {
    return { status: 'ok', fake: true };
  }

  async promptStream(sessionId: string, body: PromptBody, onDelta: (d: string) => void): Promise<void> {
    this.prompts.push({ sessionId, body });
    let skill = '';
    try {
      skill = String((JSON.parse(body.prompt) as { skill?: unknown }).skill ?? '');
    } catch {
      /* 忽略 */
    }
    if (this.heldSkills.has(skill)) {
      await new Promise<void>((resolve) => {
        const list = this.holds.get(skill) ?? [];
        list.push(resolve);
        this.holds.set(skill, list);
      });
    }
    if (this.failSkills.has(skill)) throw new GatewayError('DSH_FAILED', `fake: ${skill} 执行失败`);
    for (const d of ['分析指令…', `调用技能 ${skill}…`, '产出结果…']) {
      if (this.deltaMs > 0) await new Promise((r) => setTimeout(r, this.deltaMs));
      onDelta(d);
    }
    // 落一张产出图
    const n = (this.outputSeq.get(sessionId) ?? 0) + 1;
    this.outputSeq.set(sessionId, n);
    const files = this.sessions.get(sessionId);
    if (files) {
      files.set(`out-${String(n).padStart(2, '0')}.png`, Buffer.from(`fake-png:${sessionId}:${n}`));
      for (const extra of this.extraOutputs.get(sessionId) ?? []) files.set(extra, Buffer.from(`fake-extra:${extra}`));
    }
  }

  /** 挂起某技能的执行，返回 release 函数 */
  holdSkill(skill: string): () => void {
    this.heldSkills.add(skill);
    return () => {
      this.heldSkills.delete(skill);
      for (const fn of this.holds.get(skill) ?? []) fn();
      this.holds.delete(skill);
    };
  }

  async listFiles(sessionId: string): Promise<SessionFile[]> {
    const files = this.sessions.get(sessionId);
    if (!files) throw new GatewayError('DSH_FAILED', `unknown session ${sessionId}`);
    return [...files.entries()].map(([path, buf]) => ({ path, size: buf.length }));
  }

  async uploadFile(sessionId: string, filename: string, data: Buffer, _mime: string): Promise<string> {
    const files = this.sessions.get(sessionId);
    if (!files) throw new GatewayError('DSH_FAILED', `unknown session ${sessionId}`);
    const name = filename.split('/').pop() || 'upload.png';
    files.set(name, data);
    return name;
  }

  async downloadFile(sessionId: string, path: string): Promise<Buffer> {
    const files = this.sessions.get(sessionId);
    const data = files?.get(path);
    if (!data) throw new GatewayError('DSH_FAILED', `file not found: ${path}`);
    return data;
  }

  async cancelSession(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId);
  }
}
