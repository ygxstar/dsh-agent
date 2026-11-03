interface Props {
  enabled: boolean;
  busy: boolean;
  satisfaction: number;
  onSatisfaction: (v: number) => void;
  onConfirm: () => void;
}

/** 整批确认：满意度 1–5 → confirm → 等 done（frontend-design §3.5） */
export default function ConfirmBar({ enabled, busy, satisfaction, onSatisfaction, onConfirm }: Props) {
  return (
    <section className="panel confirm-bar">
      <h2>整批确认</h2>
      <div className="satisfaction">
        <span>满意度</span>
        {[1, 2, 3, 4, 5].map((v) => (
          <label key={v}>
            <input
              type="radio"
              name="satisfaction"
              value={v}
              checked={satisfaction === v}
              onChange={() => onSatisfaction(v)}
              disabled={busy}
            />
            {v}
          </label>
        ))}
      </div>
      <button type="button" className="primary" disabled={!enabled || busy} onClick={onConfirm}>
        {busy ? '提交中…' : '确认完成（令牌作废）'}
      </button>
      {!enabled && <p className="muted">全部单元到达待修改/确认状态后可确认</p>}
    </section>
  );
}
