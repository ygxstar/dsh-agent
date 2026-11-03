import type { CellSnapshot, CellState } from './types';

/** 单元视图模型：服务端快照字段 + 前端本地补充（流式进度、最近错误） */

export interface CellErrorView {
  code: string;
  message?: string;
  retryable: boolean;
}

export interface CellView {
  cellId: string;
  skill: string;
  state: CellState;
  outputs: string[];
  error?: { code: string; retryable: boolean };
  /** 该格流式进度拼接文本 */
  progress: string;
  /** 最近一次错误（快照 error 优先，其次本地收到的 error 事件） */
  lastError?: CellErrorView;
}

export type CellsMap = Record<string, CellView>;

const PROGRESS_CAP = 4_000;

/** 全格快照整体覆盖本地 store，进度等本地补充信息按 cellId 保留（frontend-design §3.2） */
export function rebuildCells(list: CellSnapshot[], prev: CellsMap): CellsMap {
  const next: CellsMap = {};
  for (const s of list) {
    const old = prev[s.cellId];
    next[s.cellId] = {
      cellId: s.cellId,
      skill: s.skill,
      state: s.state,
      outputs: s.outputs,
      error: s.error,
      progress: old?.progress ?? '',
      lastError: s.error
        ? { code: s.error.code, retryable: s.error.retryable }
        : old?.lastError,
    };
  }
  return next;
}

export function appendProgress(prev: CellsMap, cellId: string, delta: string): CellsMap {
  const cell = prev[cellId];
  if (!cell) return prev;
  const merged = (cell.progress + delta).slice(-PROGRESS_CAP);
  return { ...prev, [cellId]: { ...cell, progress: merged } };
}

export function addOutput(prev: CellsMap, cellId: string, imageRef: string): CellsMap {
  const cell = prev[cellId];
  if (!cell) return prev;
  const outputs = cell.outputs.includes(imageRef) ? cell.outputs : [...cell.outputs, imageRef];
  return { ...prev, [cellId]: { ...cell, outputs, lastError: undefined } };
}

export function setCellError(prev: CellsMap, cellId: string, err: CellErrorView): CellsMap {
  const cell = prev[cellId];
  if (!cell) return prev;
  return { ...prev, [cellId]: { ...cell, lastError: err } };
}

export function clearCellError(prev: CellsMap, cellId: string): CellsMap {
  const cell = prev[cellId];
  if (!cell || !cell.lastError) return prev;
  return { ...prev, [cellId]: { ...cell, lastError: undefined } };
}
