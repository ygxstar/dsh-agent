/** 网关领域类型：字段语义见 docs/gateway-interface.md 与 docs/backend-design.md */

export type TokenState = 'ACTIVE' | 'USED' | 'EXPIRED' | 'REVOKED';
export type CodeState = 'ACTIVE' | 'REVOKED';
export type CellState = 'CREATED' | 'RUNNING' | 'AWAITING_MODIFY_OR_CONFIRM' | 'FAILED' | 'DONE' | 'EXPIRED';
export type TaskState = 'CREATED' | 'RUNNING' | 'AWAITING_MODIFY_OR_CONFIRM' | 'DONE' | 'EXPIRED';

export interface Token {
  token: string;
  taskId: string;
  state: TokenState;
  createdAt: number;
  orderRef: string;
  codeRef: string | null;
}

export interface RedeemCode {
  code: string;
  orderRef: string;
  expiresAt: number;
  state: CodeState;
  claimCount: number;
  tokenRefs: string[];
  /** 领取时间戳（限频滑动窗口） */
  claimTimes: number[];
}

/** 签发时注入的任务要求，auth 时原样返回前端 */
export interface Preset {
  allowedSkillIds: string[];
  maxCells: number;
  params: Record<string, unknown>;
  text: string;
}

export interface CellError {
  code: string;
  retryable: boolean;
}

export interface Cell {
  cellId: string;
  skill: string;
  /** 展开时分配的源图引用（可为空，纯文生图） */
  sourceRef: string | null;
  /** 源图在该格会话工作区中的路径 */
  sourcePath: string | null;
  sessionId: string | null;
  state: CellState;
  outputs: string[];
  /** 该格最近一次指令的参数与文本（修改时缺省沿用） */
  params: Record<string, unknown>;
  text: string;
  /** 最近一次修改指令的目标产出（进 prompt 序列化） */
  editTarget: string | null;
  error?: CellError;
}

export interface CellSnapshot {
  cellId: string;
  skill: string;
  state: CellState;
  outputs: string[];
  error?: CellError;
}

export interface Task {
  taskId: string;
  orderRef: string;
  codeRef: string | null;
  preset: Preset;
  state: TaskState;
  /** 签发即建的任务会话（staging），源图上传落此处 */
  stagingSessionId: string;
  expanded: boolean;
  cells: Map<string, Cell>;
  createdAt: number;
  satisfaction?: number;
  /** 指令频控时间戳 */
  commandTimes: number[];
}

/* ---------- WS 上行（客户端 → 网关） ---------- */

/** auth：owner 带登录令牌 tk_*；role=viewer 时 token 为分享令牌 sh_*，taskId 必填且须与分享条目一致（ADR-0008） */
export interface AuthMsg { type: 'auth'; token: string; role?: 'viewer'; taskId?: string }
export interface CommandMsg {
  type: 'command';
  skillIds?: string[];
  params?: Record<string, unknown>;
  text?: string;
  imageRefs?: string[];
  cellId?: string;
  editTarget?: string;
}
export interface ConfirmMsg { type: 'confirm'; satisfaction?: number }
export interface PingMsg { type: 'ping' }
export type Uplink = AuthMsg | CommandMsg | ConfirmMsg | PingMsg;

/* ---------- WS 下行（网关 → 客户端） ---------- */

export interface AuthOkMsg { type: 'auth_ok'; taskId: string; state: TaskState; preset: Preset; cells: CellSnapshot[] }
export interface StateMsg { type: 'state'; state: TaskState; cells: CellSnapshot[] }
export interface ProgressMsg { type: 'progress'; cellId: string; source: 'dsh'; delta: string }
export interface ResultMsg { type: 'result'; cellId: string; imageRef: string; url: string }
export interface ErrorMsg { type: 'error'; cellId?: string; code: string; retryable?: boolean; message?: string }
export interface DoneMsg { type: 'done'; taskId: string }
export interface PongMsg { type: 'pong' }
export type Downlink = AuthOkMsg | StateMsg | ProgressMsg | ResultMsg | ErrorMsg | DoneMsg | PongMsg;

/* ---------- 错误码（gateway-interface §4.3 全集） ---------- */

export const ERROR_CODES = [
  'TOKEN_INVALID', 'TOKEN_EXPIRED', 'TOKEN_USED',
  'REDEEM_INVALID', 'REDEEM_EXPIRED', 'REDEEM_REVOKED',
  'STATE_INVALID', 'SKILL_UNKNOWN', 'SKILL_LOCKED', 'EDIT_TARGET_INVALID', 'IMAGE_REF_INVALID', 'BAD_PARAMS',
  'LIMIT', 'PAYLOAD_TOO_LARGE',
  'SHARE_INVALID', 'READONLY',
  'DSH_FAILED', 'DSH_TIMEOUT',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class GatewayError extends Error {
  constructor(public readonly code: ErrorCode, message?: string, public readonly cellId?: string, public readonly retryable = false) {
    super(message ?? code);
  }
}
