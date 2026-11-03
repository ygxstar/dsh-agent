/** 错误码 → 中文文案映射（gateway-interface §4.3 全集）；前端不做语义判断 */
const ERROR_TEXT: Record<string, string> = {
  TOKEN_INVALID: '令牌无效或已被吊销',
  TOKEN_EXPIRED: '令牌已过期',
  TOKEN_USED: '令牌已使用（任务已确认完成）',
  REDEEM_INVALID: '收货码不存在，请核对后重试',
  REDEEM_EXPIRED: '收货码已过期',
  REDEEM_REVOKED: '收货码已被吊销',
  STATE_INVALID: '当前状态不允许该操作',
  SKILL_UNKNOWN: '所选技能不在本任务可用范围内',
  SKILL_LOCKED: '该单元技能已锁定，不可更换',
  EDIT_TARGET_INVALID: '修改目标不属于该单元',
  IMAGE_REF_INVALID: '图片引用无效',
  BAD_PARAMS: '参数不符合要求',
  LIMIT: '操作过于频繁或超出数量上限',
  PAYLOAD_TOO_LARGE: '消息过大',
  DSH_FAILED: '生成失败，可重试',
  DSH_TIMEOUT: '生成超时，可重试',
};

/** 归到表单行内提示的码（无 cellId 时不进顶部 toast） */
export const FORM_ERROR_CODES = new Set([
  'SKILL_UNKNOWN',
  'SKILL_LOCKED',
  'EDIT_TARGET_INVALID',
  'IMAGE_REF_INVALID',
  'BAD_PARAMS',
  'LIMIT',
]);

/** 令牌类错误：停止重连并回兑换页 */
export const TOKEN_ERROR_CODES = new Set(['TOKEN_INVALID', 'TOKEN_EXPIRED', 'TOKEN_USED']);

export function errorText(code: string, message?: string): string {
  return ERROR_TEXT[code] ?? message ?? `未知错误（${code}）`;
}
