import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ApiError, redeem } from '../api';
import { errorText } from '../errors';
import { loadTokens, mergeTokens, removeToken, type StoredToken } from '../tokens';

/** 兑换页：唯一公网入口，凭收货码领取令牌并暂存本地（frontend-design §1、§5） */
export default function RedeemPage() {
  const location = useLocation();
  const incoming = (location.state as { error?: string } | null)?.error;

  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(incoming ?? null);
  const [busy, setBusy] = useState(false);
  const [tokens, setTokens] = useState<StoredToken[]>(loadTokens());

  const submit = async (): Promise<void> => {
    const trimmed = code.trim().toUpperCase();
    if (!trimmed) {
      setErr('请输入收货码');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const res = await redeem(trimmed);
      setTokens(mergeTokens(res.tokens));
      setCode('');
    } catch (e) {
      if (e instanceof ApiError) setErr(errorText(e.code, e.message));
      else setErr('网络错误，请稍后重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <header className="topbar">
        <h1>兑换收货码</h1>
      </header>

      <section className="panel">
        <div className="field">
          <label className="field-label" htmlFor="redeem-code">
            收货码（8 位）
          </label>
          <input
            id="redeem-code"
            type="text"
            value={code}
            maxLength={8}
            placeholder="如 AB12CD34"
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </div>
        {err && <p className="form-error">{err}</p>}
        <button type="button" className="primary" disabled={busy} onClick={() => void submit()}>
          {busy ? '兑换中…' : '兑换'}
        </button>
      </section>

      <section className="panel">
        <h2>我的任务（{tokens.length}）</h2>
        {tokens.length === 0 ? (
          <p className="muted">暂无令牌；兑换后在此列出，点击进入出图工作台。</p>
        ) : (
          <ul className="token-list">
            {tokens.map((t) => (
              <li key={t.token}>
                <span className="token-code">
                  {t.token.slice(0, 12)}…（任务 {t.taskId.slice(0, 8)}）
                </span>
                <Link className="primary" to={`/task/${t.taskId}`}>
                  进入工作台
                </Link>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    removeToken(t.token);
                    setTokens(loadTokens());
                  }}
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
