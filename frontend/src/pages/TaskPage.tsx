import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError, createShare, fetchSkills, getShare, revokeShare, shareAuth, type ShareStatus } from '../api';
import CellCard from '../components/CellCard';
import ConfirmBar from '../components/ConfirmBar';
import ParamsForm from '../components/ParamsForm';
import SkillHint from '../components/SkillHint';
import SkillPicker from '../components/SkillPicker';
import UploadArea from '../components/UploadArea';
import { errorText, FORM_ERROR_CODES } from '../errors';
import { defaultsFor, fieldsFor, withCascade } from '../form';
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

/** 由技能页跳入时携带的预绑定信息（/skill/:skillId → /task/:taskId） */
interface PreselectState {
  preselect?: string;
  params?: Record<string, unknown>;
  text?: string;
}

/** ApiError → 顶部错误视图（非 ApiError 归为不可重试） */
const toErrView = (err: unknown): ErrView =>
  err instanceof ApiError ? { code: err.code, message: err.message, retryable: false } : { code: String(err), retryable: false };

export default function TaskPage() {
  const { taskId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const stored = tokenForTask(taskId);

  /* 只读分享（ADR-0008）：URL 带 sh → viewer 模式，只读展示，不读本机 tk_* */
  const shareToken = new URLSearchParams(location.search).get('sh');
  const viewer = shareToken !== null;

  /* 技能页预绑定：取一次存入 ref，供 WS 回调与技能选择器读取 */
  const pre = useRef<PreselectState | null>((location.state as PreselectState | null) ?? null);

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

  /* ---- 只读分享（ADR-0008） ---- */
  const [shareDenied, setShareDenied] = useState(false); // sh 无效/已撤销/任务过期
  const [shareOpen, setShareOpen] = useState(false); // 所有者分享面板
  const [shareStatus, setShareStatus] = useState<ShareStatus | null>(null);
  const [copied, setCopied] = useState(false);

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
          const p = pre.current;
          if (p?.preselect) {
            // 技能页跳入：预绑定该技能并套用技能页选好的效果参数
            setSelected([p.preselect]);
            setParams({ ...m.preset.params, ...p.params });
            setText(p.text ?? m.preset.text);
          } else {
            setParams(m.preset.params);
            setText(m.preset.text);
          }
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
      if (viewer) {
        // viewer 授权失效 = 分享被停止/任务过期：就地提示，不跳兑换页
        if (code === 'SHARE_INVALID') setShareDenied(true);
        else setToast({ code, retryable: false });
        return;
      }
      if (stored) removeToken(stored.token);
      navigate('/', { state: { error: errorText(code) } });
    },
    [navigate, stored, viewer],
  );

  /* ---- WS 生命周期 ---- */
  useEffect(() => {
    if (viewer) return; // viewer 走下方只读连接
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
  }, [stored?.token, viewer]);

  /* ---- viewer 只读 WS（ADR-0008）：state 推送与所有者一致，写指令由网关以 READONLY 拒绝 ---- */
  useEffect(() => {
    if (!viewer || !shareToken || shareDenied) return;
    const ws = new TaskWs(
      shareToken,
      { onMessage, onStatus: setStatus, onTokenFatal: onFatal },
      { role: 'viewer', taskId },
    );
    wsRef.current = ws;
    ws.start();
    return () => {
      ws.stop();
      wsRef.current = null;
    };
    // onMessage/onFatal 均为稳定 useCallback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, shareToken, shareDenied, taskId]);

  /* ---- viewer 首屏快照走只读 HTTP 通道：sh 无效/撤销/任务过期 → 403 就地提示 ---- */
  useEffect(() => {
    if (!viewer || !shareToken) return;
    let dead = false;
    shareAuth(shareToken, taskId)
      .then((snap) => {
        if (dead) return;
        setPreset(snap.preset);
        setTaskState(snap.state);
        setCells((prev) => rebuildCells(snap.cells, prev));
      })
      .catch((err: unknown) => {
        if (dead) return;
        if (err instanceof ApiError && err.code === 'SHARE_INVALID') setShareDenied(true);
        else setToast(toErrView(err));
      });
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, shareToken, taskId]);

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

  /* 技能页预绑定：技能选择器只显示该技能（等效锁定） */
  const preselectId = pre.current?.preselect;
  const pickerSkills = preselectId ? allowedSkills.filter((s) => s.id === preselectId) : allowedSkills;
  const preselectForbidden = Boolean(preselectId && preset && pickerSkills.length === 0);

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

  /** 勾选技能时并入其 schema 默认值（不覆盖已填项） */
  const toggleSkill = (id: string): void => {
    const adding = !selected.includes(id);
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    if (adding) setParams((p) => ({ ...defaultsFor(allowedSkills.find((s) => s.id === id)), ...p }));
  };

  /** 参数变更；级联字段（x-filter）按依赖值同步收窄并纠正越界旧值 */
  const onParamChange = (k: string, v: unknown): void => {
    setParams((p) => withCascade(fields, p, k, v));
  };

  /* ---- 分享面板（owner，ADR-0008） ---- */
  const shareUrl =
    shareStatus?.shared && shareStatus.sh ? `${window.location.origin}/task/${taskId}?sh=${shareStatus.sh}` : '';

  /** 打开分享面板时回读当前分享状态（回显既有链接） */
  const toggleShare = (): void => {
    const next = !shareOpen;
    setShareOpen(next);
    setCopied(false);
    if (next && stored) getShare(stored.token, taskId).then(setShareStatus).catch((err) => setToast(toErrView(err)));
  };

  /** 生成/重新生成分享令牌：服务端保证每任务至多一个有效 sh_*，重复生成即轮换 */
  const generateShare = (): void => {
    if (!stored) return;
    createShare(stored.token, taskId)
      .then((s) => {
        setShareStatus(s);
        setCopied(false);
      })
      .catch((err) => setToast(toErrView(err)));
  };

  /** 停止分享：撤销后旧链接下一次请求即 403 */
  const stopShare = (): void => {
    if (!stored) return;
    revokeShare(stored.token, taskId)
      .then((s) => {
        setShareStatus(s);
        setCopied(false);
      })
      .catch((err) => setToast(toErrView(err)));
  };

  const copyShare = (): void => {
    if (!shareUrl) return;
    navigator.clipboard
      .writeText(shareUrl)
      .then(() => setCopied(true))
      .catch(() => setToast({ code: 'CLIPBOARD_FAILED', message: '复制失败，请手动复制链接', retryable: false }));
  };

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

  if (shareDenied) {
    return (
      <main className="page">
        <div className="panel">
          <h1>分享链接无效</h1>
          <p className="muted">该链接可能已被停止分享、任务已过期或不存在，请向分享者索取新链接。</p>
          <Link to="/">返回首页</Link>
        </div>
      </main>
    );
  }

  if (!stored && !viewer) {
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
        {viewer && <span className="readonly-badge">只读分享</span>}
        <span className={`conn conn-${status}`}>
          {status === 'open' ? '已连接' : status === 'connecting' ? '连接中…' : status === 'reconnecting' ? '重连中…' : '已断开'}
        </span>
        <div className="topbar-actions">
          {!viewer && (
            <button type="button" className="share-btn" onClick={toggleShare}>
              分享
            </button>
          )}
          <Link to="/" className="ghost-link">
            返回兑换页
          </Link>
        </div>
      </header>

      {!viewer && shareOpen && (
        <section className="panel share-panel">
          <div className="share-head">
            <h2>分享任务</h2>
            <button type="button" className="share-btn" onClick={() => setShareOpen(false)}>
              关闭
            </button>
          </div>
          <p className="muted">拿到链接的人只能查看任务与出图进度，不能修改、重试或确认完成。</p>
          {shareStatus?.shared && shareStatus.sh ? (
            <>
              <div className="share-link-row">
                <input
                  className="share-link"
                  readOnly
                  value={shareUrl}
                  aria-label="分享链接"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button type="button" className="primary" onClick={copyShare}>
                  {copied ? '已复制' : '复制链接'}
                </button>
              </div>
              <div className="share-actions">
                <button type="button" onClick={stopShare}>
                  停止分享
                </button>
              </div>
            </>
          ) : (
            <button type="button" className="primary" onClick={generateShare}>
              生成分享链接
            </button>
          )}
        </section>
      )}

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

      {!expanded && !viewer && (
        <>
          <UploadArea
            token={stored?.token ?? ''}
            disabled={expanded || submitting}
            refs={imageRefs}
            onAdded={(refs) => setImageRefs((prev) => [...prev, ...refs])}
            onRemove={(ref) => setImageRefs((prev) => prev.filter((r) => r !== ref))}
            onError={(code, message) => setFormErr({ code, message, retryable: false })}
          />

          <section className="panel">
            <h2>选择技能</h2>
            <SkillPicker
              skills={pickerSkills}
              selected={selected}
              onToggle={toggleSkill}
              disabled={submitting}
            />
            {preselectForbidden && <p className="form-error">本任务预设不含该技能</p>}
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

          <SkillHint skills={allowedSkills.filter((s) => selected.includes(s.id))} />

          <section className="panel">
            <h2>参数与说明</h2>
            <ParamsForm
              fields={fields}
              values={params}
              onChange={onParamChange}
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

      {viewer && !expanded && (
        <section className="panel">
          <p className="muted">任务尚未开始生成，可在此查看实时进度</p>
        </section>
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
                readOnly={viewer}
                onSend={(msg) => {
                  if (msg.cellId) setCells((prev) => clearCellError(prev, msg.cellId as string));
                  send(msg);
                }}
              />
            ))}
          </div>
        </section>
      )}

      {expanded && !viewer && (
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
