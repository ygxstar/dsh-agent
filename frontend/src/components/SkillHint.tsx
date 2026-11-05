import { useId, useState } from 'react';
import type { SkillManifest } from '../types';

interface Props {
  /** 当前所选技能（未选时展示引导文案） */
  skills: SkillManifest[];
}

/** 技能说明提示窗：展示所选技能的功能描述与用法举例，指导「参数与说明」的填写。
 *  宽屏 sticky 吸附在视口顶部跟随滚动；≤640px 改为底部固定浮窗（可折叠），兼容手机浏览器。 */
export default function SkillHint({ skills }: Props) {
  const bodyId = useId();
  const [open, setOpen] = useState(() => !window.matchMedia('(max-width: 640px)').matches);
  const names = skills.map((s) => s.displayName).join(' / ');

  return (
    <aside className={`skill-hint${open ? ' open' : ''}`} aria-label="技能说明">
      <div className="skill-hint-head">
        <span className="skill-hint-title">技能说明</span>
        <span className="skill-hint-names">{skills.length > 0 ? names : '尚未选择技能'}</span>
        <button
          type="button"
          className="ghost"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '收起' : '看说明'}
        </button>
      </div>
      <div id={bodyId} className="skill-hint-body" hidden={!open}>
        {skills.length === 0 ? (
          <p className="muted">先在上方选择技能，这里会显示每个技能的功能描述与用法举例，供填写下方参数与补充说明时参考。</p>
        ) : (
          skills.map((s) => (
            <div className="skill-hint-item" key={s.id}>
              <h3>{s.displayName}</h3>
              {s.description && <p>{s.description}</p>}
              {(s.examples?.length ?? 0) > 0 && (
                <>
                  <p className="skill-hint-label">用法举例</p>
                  <ul>
                    {s.examples?.map((ex, i) => (
                      <li key={i}>{ex}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
