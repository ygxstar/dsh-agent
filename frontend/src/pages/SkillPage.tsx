import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { fetchSkills } from '../api';
import ParamsForm from '../components/ParamsForm';
import SkillHint from '../components/SkillHint';
import { defaultsFor, fieldsFor, withCascade } from '../form';
import { loadTokens, type StoredToken } from '../tokens';
import type { SkillManifest } from '../types';

/** 技能专属页（/skill/:skillId）：预绑定该技能、展示效果选择器，
 *  选令牌后携 state 跳入通用工作台（Q3：复用 TaskPage 的 WS/上传/确认核心） */
export default function SkillPage() {
  const { skillId = '' } = useParams();
  const navigate = useNavigate();

  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [loadErr, setLoadErr] = useState(false);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [text, setText] = useState('');
  const [tokens] = useState<StoredToken[]>(loadTokens());

  const skill = skills.find((s) => s.id === skillId);

  useEffect(() => {
    fetchSkills()
      .then(setSkills)
      .catch(() => setLoadErr(true));
  }, []);

  /* 技能加载后预填其 schema 默认值（级联字段同步收窄） */
  useEffect(() => {
    if (!skill) return;
    setParams((prev) => ({ ...defaultsFor(skill), ...prev }));
  }, [skill]);

  const fields = useMemo(() => (skill ? fieldsFor([skill], [skill.id]) : []), [skill]);

  if (loadErr) {
    return (
      <main className="page">
        <div className="panel">
          <h1>技能清单加载失败</h1>
          <Link to="/">返回兑换页</Link>
        </div>
      </main>
    );
  }

  if (!skill) {
    return (
      <main className="page">
        <div className="panel">
          <h1>{skills.length === 0 ? '加载中…' : '技能不存在'}</h1>
          {skills.length > 0 && <Link to="/">返回兑换页</Link>}
        </div>
      </main>
    );
  }

  const enter = (t: StoredToken): void => {
    navigate(`/task/${t.taskId}`, { state: { preselect: skill.id, params, text } });
  };

  return (
    <main className="page">
      <header className="topbar">
        <h1>{skill.displayName}</h1>
        <span className="muted">{skill.kind === 'img2img' ? '需要源图' : '文生图'}</span>
        <Link to="/" className="ghost-link">
          返回兑换页
        </Link>
      </header>

      <section className="panel">
        <h2>效果选择</h2>
        <ParamsForm fields={fields} values={params} onChange={(k, v) => setParams((p) => withCascade(fields, p, k, v))} />
        <div className="field">
          <label className="field-label" htmlFor="skill-text">
            补充说明（可选）
          </label>
          <input id="skill-text" type="text" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
      </section>

      <SkillHint skills={[skill]} />

      <section className="panel">
        <h2>选择令牌进入工作台</h2>
        {tokens.length === 0 ? (
          <p className="muted">
            暂无令牌；请先<Link to="/">凭收货码兑换</Link>，再回到本页。
          </p>
        ) : (
          <ul className="token-list">
            {tokens.map((t) => (
              <li key={t.token}>
                <span className="token-code">
                  {t.token.slice(0, 12)}…（任务 {t.taskId.slice(0, 8)}）
                </span>
                <button type="button" className="primary" onClick={() => enter(t)}>
                  用该令牌进入
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="muted">进入后将自动选中「{skill.displayName}」并套用上方效果参数；源图在工作台上传。</p>
      </section>
    </main>
  );
}
