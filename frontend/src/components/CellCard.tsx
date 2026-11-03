import { useState } from 'react';
import { fileUrl } from '../api';
import { errorText } from '../errors';
import { fieldsFor } from '../form';
import type { CellView } from '../store';
import type { CommandMsg, SkillManifest } from '../types';
import ParamsForm from './ParamsForm';

interface Props {
  cell: CellView;
  skill?: SkillManifest;
  /** 展开时分配给该格的源图（前端按首条笛卡尔积顺序推算） */
  sourceRef: string | null;
  /** 首条指令的 params，作为逐格修改表单初值 */
  initialParams: Record<string, unknown>;
  onSend: (msg: CommandMsg) => void;
}

const STATE_TEXT: Record<string, string> = {
  CREATED: '排队中',
  RUNNING: '生成中',
  AWAITING_MODIFY_OR_CONFIRM: '待修改/确认',
  FAILED: '失败',
  DONE: '已完成',
  EXPIRED: '已过期',
};

export default function CellCard({ cell, skill, sourceRef, initialParams, onSend }: Props) {
  const [editing, setEditing] = useState(false);
  const [params, setParams] = useState<Record<string, unknown>>(initialParams);
  const [editTarget, setEditTarget] = useState('');
  const [text, setText] = useState('');
  const [formErr, setFormErr] = useState<string | null>(null);

  const modifiable = cell.state === 'AWAITING_MODIFY_OR_CONFIRM' || cell.state === 'FAILED';
  const err = cell.lastError ?? (cell.error ? { code: cell.error.code, retryable: cell.error.retryable } : undefined);
  const fields = skill ? fieldsFor([skill], [skill.id]) : [];

  const sendModify = (): void => {
    setFormErr(null);
    const msg: CommandMsg = { type: 'command', cellId: cell.cellId };
    if (Object.keys(params).length > 0) msg.params = params;
    if (editTarget) msg.editTarget = editTarget;
    if (text.trim()) msg.text = text;
    onSend(msg);
    setEditing(false);
  };

  const retry = (): void => {
    // 重试 = 同 cellId 修改指令，params/text 由服务端沿用该格现值
    onSend({ type: 'command', cellId: cell.cellId });
  };

  return (
    <article className={`cell-card state-${cell.state}`}>
      <header className="cell-head">
        <span className="cell-id">{cell.cellId}</span>
        <span className="cell-skill">{skill?.displayName ?? cell.skill}</span>
        <span className={`badge badge-${cell.state}`}>{STATE_TEXT[cell.state] ?? cell.state}</span>
      </header>

      {sourceRef && <img className="cell-source" src={fileUrl(sourceRef)} alt={`源图 ${sourceRef}`} />}

      {cell.progress && <pre className="cell-progress">{cell.progress}</pre>}

      {cell.outputs.length > 0 && (
        <div className="cell-outputs">
          {cell.outputs.map((ref) => (
            <a key={ref} href={fileUrl(ref)} target="_blank" rel="noreferrer" title={ref}>
              <img src={fileUrl(ref)} alt={ref} />
            </a>
          ))}
        </div>
      )}

      {err && (
        <p className={`cell-error${err.retryable ? ' retryable' : ''}`}>
          {errorText(err.code, err.message)}
          {err.retryable && modifiable && (
            <button type="button" className="retry" onClick={retry}>
              重试
            </button>
          )}
        </p>
      )}
      {formErr && <p className="cell-error">{formErr}</p>}

      <footer className="cell-actions">
        {modifiable && !editing && (
          <button type="button" onClick={() => setEditing(true)}>
            修改
          </button>
        )}
      </footer>

      {editing && (
        <div className="cell-editor">
          <h3>修改 {cell.cellId}</h3>
          <ParamsForm
            fields={fields}
            values={params}
            onChange={(k, v) => setParams((p) => ({ ...p, [k]: v }))}
          />
          <div className="field">
            <label className="field-label" htmlFor={`edit-target-${cell.cellId}`}>
              修改目标产出（可选）
            </label>
            <select
              id={`edit-target-${cell.cellId}`}
              value={editTarget}
              onChange={(e) => setEditTarget(e.target.value)}
            >
              <option value="">整图重绘（不指定）</option>
              {cell.outputs.map((ref) => (
                <option key={ref} value={ref}>
                  {ref}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`edit-text-${cell.cellId}`}>
              补充说明（可选）
            </label>
            <input
              id={`edit-text-${cell.cellId}`}
              type="text"
              value={text}
              placeholder="如：把建筑处理成粗网点"
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <div className="cell-editor-actions">
            <button type="button" onClick={sendModify}>
              发送修改
            </button>
            <button type="button" className="ghost" onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
