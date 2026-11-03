export interface Config {
  /** 公网 HTTP+WS 监听端口 */
  port: number;
  /** 管理 API 监听地址（仅内网，不发布宿主端口） */
  adminHost: string;
  adminPort: number;
  /** dsh-webapi 基址，含 /api/v1 前缀 */
  dshBaseUrl: string;
  dshApiKey: string;
  /** 格级会话并发上限 */
  maxConcurrentCells: number;
  /** 单条 WS 消息 / HTTP 请求体大小上限（字节） */
  maxPayloadBytes: number;
  /** 单张上传图片大小上限（字节） */
  maxUploadBytes: number;
  /** 每任务每分钟指令条数上限 */
  commandRateLimit: number;
  /** 每收货码每分钟领取次数上限 */
  redeemRateLimit: number;
  /** DSH 流停滞看门（毫秒） */
  stallTimeoutMs: number;
  /** 任务未确认过期窗口（毫秒），默认 24h */
  taskTtlMs: number;
  /** 前端构建产物目录（存在则由网关托管静态页） */
  staticDir: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${key} 不是数字: ${raw}`);
    return value;
  };
  return {
    port: num('GATEWAY_PORT', 8080),
    adminHost: env.GATEWAY_ADMIN_HOST ?? '127.0.0.1',
    adminPort: num('GATEWAY_ADMIN_PORT', 8081),
    dshBaseUrl: (env.DSH_BASE_URL ?? 'http://127.0.0.1:3080/api/v1').replace(/\/$/, ''),
    dshApiKey: env.DSH_WEB_API_KEY ?? '',
    maxConcurrentCells: num('MAX_CONCURRENT_CELLS', 3),
    maxPayloadBytes: num('MAX_PAYLOAD_BYTES', 256 * 1024),
    maxUploadBytes: num('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
    commandRateLimit: num('COMMAND_RATE_LIMIT', 30),
    redeemRateLimit: num('REDEEM_RATE_LIMIT', 10),
    stallTimeoutMs: num('STALL_TIMEOUT_MS', 300_000),
    taskTtlMs: num('TASK_TTL_MS', 24 * 60 * 60 * 1000),
    staticDir: env.STATIC_DIR || null,
  };
}
