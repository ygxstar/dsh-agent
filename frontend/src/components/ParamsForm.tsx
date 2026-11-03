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
        return (
          <div className="field" key={f.key}>
            {label}
            {f.enum && f.enum.length > 0 ? (
              <select
                id={`param-${f.key}`}
                disabled={disabled}
                value={typeof value === 'string' ? value : ''}
                onChange={(e) => onChange(f.key, e.target.value)}
              >
                {!f.required ? <option value="">（不填）</option> : null}
                {f.enum.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
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
