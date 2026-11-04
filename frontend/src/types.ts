/** 网关协议前端侧类型副本；语义唯一源为 docs/gateway-interface.md §4 */

export type CellState = 'CREATED' | 'RUNNING' | 'AWAITING_MODIFY_OR_CONFIRM' | 'FAILED' | 'DONE' | 'EXPIRED';
export type TaskState = 'CREATED' | 'RUNNING' | 'AWAITING_MODIFY_OR_CONFIRM' | 'DONE' | 'EXPIRED';

export interface Preset {
  allowedSkillIds: string[];
  maxCells: number;
  params: Record<string, unknown>;
  text: string;
}

export interface CellSnapshot {
  cellId: string;
  skill: string;
  state: CellState;
  outputs: string[];
  error?: { code: string; retryable: boolean };
}

/* ---- WS 上行 ---- */
export interface AuthMsg {
  type: 'auth';
  token: string;
}
export interface CommandMsg {
  type: 'command';
  skillIds?: string[];
  params?: Record<string, unknown>;
  text?: string;
  imageRefs?: string[];
  cellId?: string;
  editTarget?: string;
}
export interface ConfirmMsg {
  type: 'confirm';
  satisfaction?: number;
}
export interface PingMsg {
  type: 'ping';
}
export type Uplink = AuthMsg | CommandMsg | ConfirmMsg | PingMsg;

/* ---- WS 下行 ---- */
export interface AuthOkMsg {
  type: 'auth_ok';
  taskId: string;
  state: TaskState;
  preset: Preset;
  cells: CellSnapshot[];
}
export interface StateMsg {
  type: 'state';
  state: TaskState;
  cells: CellSnapshot[];
}
export interface ProgressMsg {
  type: 'progress';
  cellId: string;
  source: 'dsh';
  delta: string;
}
export interface ResultMsg {
  type: 'result';
  cellId: string;
  imageRef: string;
  url: string;
}
export interface ErrorMsg {
  type: 'error';
  cellId?: string;
  code: string;
  retryable?: boolean;
  message?: string;
}
export interface DoneMsg {
  type: 'done';
  taskId: string;
}
export interface PongMsg {
  type: 'pong';
}
export type Downlink = AuthOkMsg | StateMsg | ProgressMsg | ResultMsg | ErrorMsg | DoneMsg | PongMsg;

/* ---- 技能清单 ---- */
export interface ParamField {
  type?: string;
  enum?: string[];
  description?: string;
  maxLength?: number;
  /** 与 enum 等长的中文显示名，缺省回退为 enum 值 */
  enumLabels?: string[];
  minimum?: number;
  maximum?: number;
  default?: unknown;
  /** 级联：本字段 enum 按 `${依赖字段值}-` 前缀过滤（photo-story 风格名） */
  'x-filter'?: string;
}
export interface ParamsSchema {
  type?: string;
  properties?: Record<string, ParamField>;
  required?: string[];
}
export interface SkillManifest {
  id: string;
  displayName: string;
  kind: 'txt2img' | 'img2img';
  requiresSourceImage: boolean;
  paramsSchema: ParamsSchema;
}
