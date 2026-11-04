import type { ParamsSchema, SkillManifest } from './types';

/** 按所选技能的 paramsSchema 合并出表单字段（同名字段只渲染一次） */

export interface FormField {
  key: string;
  type: string;
  enum?: string[];
  enumLabels?: string[];
  description?: string;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  'x-filter'?: string;
  required: boolean;
}

export function fieldsFor(skills: SkillManifest[], selectedIds: string[]): FormField[] {
  const out: FormField[] = [];
  for (const id of selectedIds) {
    const skill = skills.find((s) => s.id === id);
    if (!skill) continue;
    const schema: ParamsSchema = skill.paramsSchema ?? {};
    const required = new Set(schema.required ?? []);
    for (const [key, field] of Object.entries(schema.properties ?? {})) {
      const existing = out.find((f) => f.key === key);
      if (existing) {
        if (required.has(key)) existing.required = true;
        continue;
      }
      out.push({
        key,
        type: field.type ?? 'string',
        enum: field.enum,
        enumLabels: field.enumLabels,
        description: field.description,
        maxLength: field.maxLength,
        minimum: field.minimum,
        maximum: field.maximum,
        default: field.default,
        'x-filter': field['x-filter'],
        required: required.has(key),
      });
    }
  }
  return out;
}

/** 技能 schema 中带 default 的参数初值（技能页/选技能时预填效果选项） */
export function defaultsFor(skill: SkillManifest | undefined): Record<string, unknown> {
  if (!skill) return {};
  const props = skill.paramsSchema?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(props)) {
    if (v && typeof v === 'object' && 'default' in v) out[key] = (v as { default: unknown }).default;
  }
  return out;
}

/** 应用参数变更并级联收窄：x-filter 字段的 enum 按 `${值}-` 前缀过滤，纠正越界旧值 */
export function withCascade(
  fields: FormField[],
  base: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base, [key]: value };
  for (const f of fields) {
    if (f['x-filter'] !== key || !f.enum || f.enum.length === 0) continue;
    const filtered = f.enum.filter((o) => o.startsWith(`${String(value)}-`));
    if (filtered.length === 0) continue;
    const cur = next[f.key];
    if (cur === undefined || typeof cur !== 'string' || !filtered.includes(cur)) next[f.key] = filtered[0];
  }
  return next;
}
