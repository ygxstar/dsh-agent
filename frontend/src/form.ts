import type { ParamsSchema, SkillManifest } from './types';

/** 按所选技能的 paramsSchema 合并出表单字段（同名字段只渲染一次） */

export interface FormField {
  key: string;
  type: string;
  enum?: string[];
  description?: string;
  maxLength?: number;
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
        description: field.description,
        maxLength: field.maxLength,
        required: required.has(key),
      });
    }
  }
  return out;
}
