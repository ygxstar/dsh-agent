import type { FormField } from '../form';

interface Props {
  fields: FormField[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
}

/** 按 Manifest paramsSchema 自动生成表单（frontend-design §2 form/params） */
export default function ParamsForm({ fields, values, onChange, disabled }: Props) {
  if (fields.length === 0) return null;
  return (
    <div className="params-form">
      {fields.map((f) => {
        const value = values[f.key];
        const label = (
          <label className="field-label" htmlFor={`param-${f.key}`}>
            {f.description ?? f.key}
            {f.required ? <span className="req">*</span> : null}
          </label>
        );
        /* 级联过滤：enum 取值按依赖字段当前值的 `<值>-` 前缀收窄（photo-story 风格名） */
        let opts = f.enum ?? [];
        const dep = f['x-filter'];
        if (dep && opts.length > 0) {
          const sel = values[dep];
          if (typeof sel === 'string' && sel) opts = opts.filter((o) => o.startsWith(`${sel}-`));
        }
        /* 显示名按原始 enum 下标对齐（过滤后下标会漂移） */
        const labelOf = (opt: string): string => {
          const i = (f.enum ?? []).indexOf(opt);
          return i >= 0 ? (f.enumLabels?.[i] ?? opt) : opt;
        };
        const isSlider = f.type === 'number' && typeof f.minimum === 'number' && typeof f.maximum === 'number';
        return (
          <div className="field" key={f.key}>
            {label}
            {opts.length > 0 ? (
              <select
                id={`param-${f.key}`}
                disabled={disabled}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => onChange(f.key, e.target.value)}
              >
                {!f.required ? <option value="">（不填）</option> : null}
                {opts.map((opt) => (
                  <option key={opt} value={opt}>
                    {labelOf(opt)}
                  </option>
                ))}
              </select>
            ) : f.type === 'number' && isSlider ? (
              <span className="slider-row">
                <input
                  id={`param-${f.key}`}
                  type="range"
                  min={f.minimum}
                  max={f.maximum}
                  disabled={disabled}
                  value={typeof value === 'number' ? value : (f.default as number | undefined) ?? f.minimum}
                  onChange={(e) => onChange(f.key, Number(e.target.value))}
                />
                <output htmlFor={`param-${f.key}`}>{typeof value === 'number' ? value : ((f.default as number | undefined) ?? f.minimum)}</output>
              </span>
            ) : f.type === 'number' ? (
              <input
                id={`param-${f.key}`}
                type="number"
                disabled={disabled}
                value={typeof value === 'number' ? value : ''}
                onChange={(e) => onChange(f.key, e.target.value === '' ? undefined : Number(e.target.value))}
              />
            ) : f.type === 'boolean' ? (
              <input
                id={`param-${f.key}`}
                type="checkbox"
                disabled={disabled}
                checked={value === true}
                onChange={(e) => onChange(f.key, e.target.checked)}
              />
            ) : (
              <input
                id={`param-${f.key}`}
                type="text"
                disabled={disabled}
                maxLength={f.maxLength}
                placeholder={f.description ?? f.key}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => onChange(f.key, e.target.value)}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
