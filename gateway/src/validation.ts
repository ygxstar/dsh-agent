import { Ajv, type ValidateFunction } from 'ajv';
import type { FileRegistry } from './files.js';
import type { ManifestStore } from './manifest.js';
import type { CommandMsg, Task } from './types.js';
import { GatewayError } from './types.js';

export interface CellPair {
  cellId: string;
  skill: string;
  sourceRef: string | null;
}

export interface FirstPlan {
  kind: 'first';
  pairs: CellPair[];
  params: Record<string, unknown>;
  text: string;
}

export interface ModifyPlan {
  kind: 'modify';
  cellId: string;
  editTarget: string | null;
  params: Record<string, unknown>;
  text: string;
}

export type CommandPlan = FirstPlan | ModifyPlan;

export interface ValidatorDeps {
  manifest: ManifestStore;
  files: FileRegistry;
  commandRateLimit: number;
}

/**
 * 校验管道（backend-design §7）：顺序执行，任一步失败抛出的 GatewayError
 * 即为返回给前端的错误码，不触碰 DSH。
 */
export class Validator {
  private readonly ajv = new Ajv({ allErrors: true, strict: false });
  private readonly compiled = new Map<string, ValidateFunction>();

  constructor(private readonly deps: ValidatorDeps) {}

  validateCommand(task: Task, msg: CommandMsg, now = Date.now()): CommandPlan {
    // 2. 任务状态机
    if (task.state === 'DONE' || task.state === 'EXPIRED') throw new GatewayError('STATE_INVALID');
    if (task.state === 'RUNNING' && !task.expanded) throw new GatewayError('STATE_INVALID');
    // 已展开但仍有格在跑：修改/重试按格校验，格 RUNNING 时该格拒绝

    const plan = task.expanded ? this.validateModify(task, msg, now) : this.validateFirst(task, msg, now);
    // 6. 频控（大小由传输层截断）
    task.commandTimes = task.commandTimes.filter((t) => now - t < 60_000);
    if (task.commandTimes.length >= this.deps.commandRateLimit) throw new GatewayError('LIMIT');
    task.commandTimes.push(now);
    return plan;
  }

  private validateFirst(task: Task, msg: CommandMsg, now: number): FirstPlan {
    void now;
    // 2. 首条：preset 白名单 + maxCells + Manifest 存在性
    if (!Array.isArray(msg.skillIds) || msg.skillIds.length === 0 || msg.skillIds.some((s) => typeof s !== 'string')) {
      throw new GatewayError('BAD_PARAMS', '首条指令必须携带 skillIds');
    }
    const skillIds = [...new Set(msg.skillIds as string[])];
    for (const id of skillIds) {
      if (!task.preset.allowedSkillIds.includes(id)) throw new GatewayError('SKILL_UNKNOWN', `技能不在任务白名单: ${id}`);
    }
    const imageRefs = msg.imageRefs ?? [];
    if (!Array.isArray(imageRefs) || imageRefs.some((r) => typeof r !== 'string')) {
      throw new GatewayError('BAD_PARAMS', 'imageRefs 必须是字符串数组');
    }
    const cellCount = Math.max(imageRefs.length, 1) * skillIds.length;
    if (cellCount > task.preset.maxCells) {
      throw new GatewayError('LIMIT', `单元数 ${cellCount} 超过上限 ${task.preset.maxCells}`);
    }
    const skills = skillIds.map((id) => {
      const skill = this.deps.manifest.get(id);
      if (!skill) throw new GatewayError('SKILL_UNKNOWN', `技能不存在: ${id}`);
      return skill;
    });

    // 3. params JSON Schema（preset 预填值可被覆盖）
    const params = { ...task.preset.params, ...(msg.params ?? {}) };
    for (const skill of skills) this.checkParams(skill.id, skill.paramsSchema, params);

    // 4.（首条无 editTarget 归属问题；带 cellId 属于修改语义）
    if (msg.cellId !== undefined) throw new GatewayError('BAD_PARAMS', '首条指令不应携带 cellId');

    // 5. 源图：仅首条、须为本任务已 upload 的引用
    for (const ref of imageRefs) {
      const entry = this.deps.files.get(ref);
      if (!entry || entry.kind !== 'source' || entry.sessionId !== task.stagingSessionId) {
        throw new GatewayError('IMAGE_REF_INVALID', `源图引用无效: ${ref}`);
      }
    }
    for (const skill of skills) {
      if (skill.requiresSourceImage && imageRefs.length === 0) {
        throw new GatewayError('IMAGE_REF_INVALID', `技能 ${skill.id} 需要源图`);
      }
    }

    const sources: (string | null)[] = imageRefs.length > 0 ? imageRefs : [null];
    const pairs: CellPair[] = [];
    let index = 0;
    for (const sourceRef of sources) {
      for (const skill of skills) {
        index += 1;
        pairs.push({ cellId: `cell_${String(index).padStart(2, '0')}`, skill: skill.id, sourceRef });
      }
    }
    const text = typeof msg.text === 'string' ? msg.text : task.preset.text;
    return { kind: 'first', pairs, params, text };
  }

  private validateModify(task: Task, msg: CommandMsg, now: number): ModifyPlan {
    void now;
    // 2. 修改：cellId 归属 + 格锁定（省略 skillIds）
    if (msg.skillIds !== undefined) throw new GatewayError('SKILL_LOCKED', '技能在格内锁定，不可更换');
    if (msg.imageRefs !== undefined && msg.imageRefs.length > 0) {
      throw new GatewayError('IMAGE_REF_INVALID', '任务内禁止再传新图');
    }
    if (typeof msg.cellId !== 'string' || msg.cellId.length === 0) {
      throw new GatewayError('BAD_PARAMS', '修改指令必须携带 cellId');
    }
    const cell = task.cells.get(msg.cellId);
    if (!cell) throw new GatewayError('STATE_INVALID', `单元不存在: ${msg.cellId}`, msg.cellId);
    if (cell.state === 'CREATED' || cell.state === 'RUNNING') {
      throw new GatewayError('STATE_INVALID', `单元状态 ${cell.state} 不可修改`, cell.cellId);
    }
    if (cell.state === 'DONE' || cell.state === 'EXPIRED') {
      throw new GatewayError('STATE_INVALID', `单元状态 ${cell.state} 不可修改`, cell.cellId);
    }

    // 3. params JSON Schema（沿用该格技能）
    const skill = this.deps.manifest.get(cell.skill);
    if (!skill) throw new GatewayError('SKILL_UNKNOWN', `技能不存在: ${cell.skill}`, cell.cellId);
    const params = { ...cell.params, ...(msg.params ?? {}) };
    this.checkParams(skill.id, skill.paramsSchema, params);

    // 4. editTarget 同格产出登记
    let editTarget: string | null = null;
    if (msg.editTarget !== undefined) {
      if (typeof msg.editTarget !== 'string' || !cell.outputs.includes(msg.editTarget)) {
        throw new GatewayError('EDIT_TARGET_INVALID', `editTarget 不属于该格: ${msg.editTarget}`, cell.cellId);
      }
      editTarget = msg.editTarget;
    }

    // 5. 源图仅首条一次（服务端强制）
    if (msg.imageRefs !== undefined) throw new GatewayError('IMAGE_REF_INVALID', '任务内禁止再传新图');

    const text = typeof msg.text === 'string' ? msg.text : cell.text;
    return { kind: 'modify', cellId: cell.cellId, editTarget, params, text };
  }

  /** 确认：任务须处于可确认态，满意度 1–5 整数可选 */
  validateConfirm(task: Task, satisfaction: unknown): number | undefined {
    if (task.state !== 'AWAITING_MODIFY_OR_CONFIRM') {
      throw new GatewayError('STATE_INVALID', `任务状态 ${task.state} 不可确认`);
    }
    if (satisfaction !== undefined) {
      if (typeof satisfaction !== 'number' || !Number.isInteger(satisfaction) || satisfaction < 1 || satisfaction > 5) {
        throw new GatewayError('BAD_PARAMS', 'satisfaction 须为 1–5 整数');
      }
      return satisfaction;
    }
    return undefined;
  }

  private checkParams(skillId: string, schema: Record<string, unknown>, params: Record<string, unknown>): void {
    let validate = this.compiled.get(skillId);
    if (!validate) {
      validate = this.ajv.compile(schema);
      this.compiled.set(skillId, validate);
    }
    if (!validate(params)) {
      const first = validate.errors?.[0];
      throw new GatewayError('BAD_PARAMS', `${skillId}: ${first?.instancePath || '/'} ${first?.message ?? '参数无效'}`);
    }
  }
}
