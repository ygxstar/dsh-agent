#!/usr/bin/env bash
# dsh web 宿主服务启动：--host 拒绝通配符，容器内须绑定网卡具体 IP。
set -euo pipefail

PORT="${DSH_WEB_PORT:-3080}"

# 取容器第一块非回环 IPv4（node 保证存在，避免依赖 iproute2）
BIND_IP="${DSH_BIND_IP:-$(node -e '
  const ifs = require("os").networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === "IPv4" && !i.internal) { console.log(i.address); process.exit(0); }
    }
  }
  process.exit(1);
')}"

echo "[entrypoint] dsh web listening on ${BIND_IP}:${PORT} (profile: web)"
exec dsh --profile web --host "${BIND_IP}" --port "${PORT}" --no-open
