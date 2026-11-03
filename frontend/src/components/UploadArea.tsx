import { useRef, useState } from 'react';
import { ApiError, fileUrl, upload } from '../api';

interface Props {
  token: string;
  /** 首条指令已发出后禁用（源图仅首条一次，服务端强制） */
  disabled: boolean;
  refs: string[];
  onAdded: (refs: string[]) => void;
  onRemove: (ref: string) => void;
  onError: (code: string, message?: string) => void;
}

/** 选图 → POST /upload → 收集 imageRefs（frontend-design §2 upload/refs） */
export default function UploadArea({ token, disabled, refs, onAdded, onRemove, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    setBusy(true);
    try {
      const added: string[] = [];
      for (const file of Array.from(files)) {
        const res = await upload(file, token);
        added.push(res.imageRef);
      }
      onAdded(added);
      if (inputRef.current) inputRef.current.value = '';
    } catch (e) {
      if (e instanceof ApiError) onError(e.code, e.message);
      else onError('UPLOAD_FAILED', String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2>源图（仅首条指令前可传）</h2>
      <label className={`upload-drop${disabled ? ' disabled' : ''}`}>
        {disabled ? '任务已展开，不能再传新图' : busy ? '上传中…' : '点击选择图片（可多选，单张 ≤ 10MB）'}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          multiple
          disabled={disabled || busy}
          onChange={(e) => void handleFiles(e.target.files)}
        />
      </label>
      {refs.length > 0 && (
        <ul className="thumb-list">
          {refs.map((ref) => (
            <li key={ref}>
              <img src={fileUrl(ref)} alt={ref} />
              {!disabled && (
                <button type="button" className="ghost" onClick={() => onRemove(ref)}>
                  移除
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
