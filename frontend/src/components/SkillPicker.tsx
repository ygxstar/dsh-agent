import type { SkillManifest } from '../types';

interface Props {
  skills: SkillManifest[];
  selected: string[];
  onToggle: (id: string) => void;
  disabled?: boolean;
}

/** 技能多选卡片：受 preset.allowedSkillIds 过滤后的清单渲染（frontend-design §2 form/skill-picker） */
export default function SkillPicker({ skills, selected, onToggle, disabled }: Props) {
  if (skills.length === 0) {
    return <p className="muted">任务未开放任何技能</p>;
  }
  return (
    <div className="skill-picker">
      {skills.map((s) => {
        const active = selected.includes(s.id);
        return (
          <button
            type="button"
            key={s.id}
            className={`skill-card${active ? ' active' : ''}`}
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onToggle(s.id)}
          >
            <span className="skill-name">{s.displayName}</span>
            <span className="skill-meta">
              {s.kind === 'txt2img' ? '文生图' : '图生图'}
              {s.requiresSourceImage ? ' · 需源图' : ''}
            </span>
          </button>
        );
      })}
    </div>
  );
}
