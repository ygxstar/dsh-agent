import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { fetchSkills } from '../api';
import CellCard from '../components/CellCard';
import ConfirmBar from '../components/ConfirmBar';
import ParamsForm from '../components/ParamsForm';
import SkillPicker from '../components/SkillPicker';
import UploadArea from '../components/UploadArea';
import { errorText, FORM_ERROR_CODES } from '../errors';
import { fieldsFor } from '../form';
import { removeToken, tokenForTask } from '../tokens';
import {
  addOutput,
  appendProgress,
  clearCellError,
  rebuildCells,
  setCellError,
  type CellsMap,
} from '../store';
import type { CommandMsg, Downlink, Preset, SkillManifest, TaskState, Uplink } from '../types';
import { TaskWs, type WsStatus } from '../ws';

interface ErrView {
  code: string;
  message?: string;
  retryable: boolean;
}

export default function TaskPage() {
  const { taskId = '' } = useParams();
  const navigate = useNavigate();
  const stored = tokenForTask(taskId);

  /* ---- 清单与连接 ---- */
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [status, setStatus] = useState<WsStatus>('connecting');
  const wsRef = useRef<TaskWs | null>(null);

  /* ---- 任务快照 ---- */
  const [preset, setPreset] = useState<Preset | null>(null);
  const [taskState, setTaskState] = useState<TaskState>('CREATED');
  const [cells, setCells] = useState<CellsMap>({});
  const [done, setDone] = useState(false);

  /* ---- 首条指令表单 ---- */
  const [selected, setSelected] = useState<string[]>([]);
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [text, setText] = useState('');
  const [imageRefs, setImageRefs] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formErr, setFormErr] = useState<ErrView | null>(null);
  const [toast, setToast] = useState<ErrView | null>(null);
  const [satisfaction, setSatisfaction] = useState(5);
  const [confirming, setConfirming] = useState(false);

  const presetApplied = useRef(false);
  const firstCmdRef = useRef<{ skillIds: string[]; imageRefs: string[] } | null>(null);
  const lastParamsRef = useRef<Record<string, unknown>>({});
  const tokenRef = useRef<string | undefined>(stored?.token);
  tokenRef.current = stored?.token;

  /* ---- 消息分发（handlers 引用稳定 setter） ---- */
  const onMessage = useCallback((m: Downlink) => {
    switch (m.type) {
      case 'auth_ok': {
        setPreset(m.preset);
        setTaskState(m.state);
        setCells((prev) => rebuildCells(m.cells, prev));
        if (!presetApplied.current) {
          presetApplied.current = true;
          setParams(m.preset.params);
          setText(m.preset.text);
        }
        break;
      }
      case 'state': {
        setTaskState(m.state);
        setCells((prev) => rebuildCells(m.cells, prev));
        setSubmitting(false);
        break;
      }
      case 'progress':
        setCells((prev) => appendProgress(prev, m.cellId, m.delta));
        break;
      case 'result':
        setCells((prev) => addOutput(prev, m.cellId, m.imageRef));
        break;
      case 'error': {
        const view: ErrView = { code: m.code, message: m.message, retryable: Boolean(m.retryable) };
        if (m.cellId) {
          setCells((prev) => setCellError(prev, m.cellId as string, view));
        } else {
          setSubmitting(false);
          if (FORM_ERROR_CODES.has(m.code)) setFormErr(view);
          else setToast(view);
        }
        break;
      }
      case 'done':
        // 令牌已 USED，从本地列表移除（兑换页不再列出）
        if (tokenRef.current) removeToken(tokenRef.current);
        setDone(true);
        setConfirming(false);
        break;
      case 'pong':
        break;
    }
  }, []);

  const onFatal = useCallback(
    (code: string) => {
      if (stored) removeToken(stored.token);
      navigate('/', { state: { error: errorText(code) } });
    },
    [navigate, stored],
  );

  /* ---- WS 生命周期 ---- */
  useEffect(() => {
    if (!stored) return;
    const ws = new TaskWs(stored.token, {
      onMessage,
      onStatus: setStatus,
      onTokenFatal: onFatal,
    });
    wsRef.current = ws;
    ws.start();
    return () => {
      ws.stop();
      wsRef.current = null;
    };
    // onMessage/onFatal 均为稳定 useCallback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored?.token]);

  /* ---- 技能清单 ---- */
  useEffect(() => {
    fetchSkills()
      .then(setSkills)
      .catch(() => setToast({ code: 'SKILLS_UNAVAILABLE', message: '技能清单加载失败', retryable: false }));
  }, []);

  /* ---- toast 自动消失 ---- */
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const allowedSkills = useMemo(
    () => (preset ? skills.filter((s) => preset.allowedSkillIds.includes(s.id)) : []),
    [skills, preset],
  );

  const expanded = Object.keys(cells).length > 0;
  const running = Object.values(cells).some((c) => c.state === 'RUNNING' || c.state === 'CREATED');
  const awaiting = taskState === 'AWAITING_MODIFY_OR_CONFIRM';

  /* ---- 首条指令：本地预览（frontend-design §3.1） ---- */
  const cellCount = Math.max(imageRefs.length, 1) * selected.length;
  const missingSource =
    imageRefs.length === 0 && selected.some((id) => allowedSkills.find((s) => s.id === id)?.requiresSourceImage);
  const overLimit = preset !== null && cellCount > preset.maxCells;
  const canSubmit =
    selected.length > 0 && !missingSource && !overLimit && !submitting && status === 'open' && !expanded;

  const send = useCallback((msg: Uplink) => {
    const ok = wsRef.current?.send(msg);
    if (!ok) setToast({ code: 'WS_NOT_READY', message: '连接未就绪，请稍后重试', retryable: true });
  }, []);

  const submitFirst = (): void => {
    if (!canSubmit) return;
    setFormErr(null);
    lastParamsRef.current = params;
    firstCmdRef.current = { skillIds: selected, imageRefs };
    const msg: CommandMsg = { type: 'command', skillIds: selected, params };
    if (imageRefs.length > 0) msg.imageRefs = imageRefs;
    if (text.trim()) msg.text = text;
    setSubmitting(true);
    send(msg);
  };

  const doConfirm = (): void => {
    setConfirming(true);
    send({ type: 'confirm', satisfaction });
  };

  /* ---- 展开后按笛卡尔积顺序推算每格源图 ---- */
  const sourceByCell = useMemo(() => {
    const map: Record<string, string | null> = {};
    const first = firstCmdRef.current;
    if (!first || Object.keys(cells).length === 0) return map;
    const sources = first.imageRefs.length > 0 ? first.imageRefs : [null];
    let i = 0;
    for (const src of sources) {
      for (const sid of first.skillIds) {
        i += 1;
        map[`cell_${String(i).padStart(2, '0')}`] = src;
        void sid;
      }
    }
    return map;
    // cells 变化即重新推算
  }, [cells]);

  const fields = fieldsFor(allowedSkills, selected);

  if (done) {
    return (
      <main className="page">
        <div className="panel done-panel">
          <h1>任务已完成</h1>
          <p className="muted">令牌已作废，本次任务的产出图可在此页面关闭前下载留存。</p>
          <Link className="primary" to="/">
            返回兑换页
          </Link>
        </div>
      </main>
    );
  }

  if (!stored) {
    return (
      <main className="page">
        <div className="panel">
          <h1>未找到本任务的令牌</h1>
          <p className="muted">请先在兑换页用收货码领取令牌。</p>
          <Link to="/">返回兑换页</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="topbar">
        <h1>出图工作台</h1>
        <span className="muted">任务 {taskId}</span>
        <span className={`conn conn-${status}`}>
          {status === 'open' ? '已连接' : status === 'connecting' ? '连接中…' : status === 'reconnecting' ? '重连中…' : '已断开'}
        </span>
        <Link to="/" className="ghost-link">
          返回兑换页
        </Link>
      </header>

      {toast && <div className="toast">{errorText(toast.code, toast.message)}</div>}

      <section className="panel">
        <h2>任务要求</h2>
        <dl className="preset-info">
          <dt>可用技能</dt>
          <dd>{preset ? preset.allowedSkillIds.length : 0} 个</dd>
          <dt>单元上限</dt>
          <dd>{preset?.maxCells ?? '-'}</dd>
        </dl>
      </section>

      {!expanded && (
        <>
          <UploadArea
            token={stored.token}
            disabled={expanded || submitting}
            refs={imageRefs}
            onAdded={(refs) => setImageRefs((prev) => [...prev, ...refs])}
            onRemove={(ref) => setImageRefs((prev) => prev.filter((r) => r !== ref))}
            onError={(code, message) => setFormErr({ code, message, retryable: false })}
          />

          <section className="panel">
            <h2>选择技能</h2>
            <SkillPicker
              skills={allowedSkills}
              selected={selected}
              onToggle={(id) =>
                setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
              }
              disabled={submitting}
            />
            {formErr && <p className="form-error">{errorText(formErr.code, formErr.message)}</p>}
            {missingSource && <p className="form-error">所选技能需要先上传源图</p>}
            {overLimit && (
              <p className="form-error">
                预计生成 {cellCount} 个单元，超过本任务上限 {preset?.maxCells}
              </p>
            )}
            {!submitting && selected.length > 0 && !missingSource && !overLimit && (
              <p className="muted">将生成 {cellCount} 个出图单元</p>
            )}
          </section>

          <section className="panel">
            <h2>参数与说明</h2>
            <ParamsForm
              fields={fields}
              values={params}
              onChange={(k, v) => setParams((p) => ({ ...p, [k]: v }))}
              disabled={submitting}
            />
            <div className="field">
              <label className="field-label" htmlFor="first-text">
                补充说明（可选）
              </label>
              <input
                id="first-text"
                type="text"
                value={text}
                disabled={submitting}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
            <button type="button" className="primary" disabled={!canSubmit} onClick={submitFirst}>
              {submitting ? '提交中…' : '开始生成'}
            </button>
          </section>
        </>
      )}

      {expanded && (
        <section className="panel">
          <h2>出图单元（{Object.keys(cells).length}）</h2>
          <div className="cell-grid">
            {Object.values(cells).map((cell) => (
              <CellCard
                key={cell.cellId}
                cell={cell}
                skill={skills.find((s) => s.id === cell.skill)}
                sourceRef={sourceByCell[cell.cellId] ?? null}
                initialParams={lastParamsRef.current}
                onSend={(msg) => {
                  if (msg.cellId) setCells((prev) => clearCellError(prev, msg.cellId as string));
                  send(msg);
                }}
              />
            ))}
          </div>
        </section>
      )}

      {expanded && (
        <ConfirmBar
          enabled={awaiting && !running}
          busy={confirming}
          satisfaction={satisfaction}
          onSatisfaction={setSatisfaction}
          onConfirm={doConfirm}
        />
      )}
    </main>
  );
}
