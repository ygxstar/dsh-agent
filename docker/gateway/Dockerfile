# 网关镜像：前端静态产物 + 网关进程（调研报告 §4 容器 A，backend-design §8）
# 多阶段：先 build 前端与网关，再只带运行时产物与生产依赖
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY gateway/package.json gateway/
COPY frontend/package.json frontend/
COPY stub-dsh/package.json stub-dsh/
RUN npm ci

COPY gateway gateway
COPY frontend frontend
RUN npm -w frontend run build && npm -w gateway run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY gateway/package.json gateway/
COPY frontend/package.json frontend/
COPY stub-dsh/package.json stub-dsh/
RUN npm ci --omit=dev

COPY --from=build /app/gateway/dist gateway/dist
COPY --from=build /app/frontend/dist frontend/dist

ENV STATIC_DIR=/app/frontend/dist \
    GATEWAY_ADMIN_HOST=127.0.0.1

EXPOSE 8080

# 公网首页由 STATIC_DIR 托管，200 即前端可服务；admin 不发布宿主端口
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATEWAY_PORT||8080)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/gateway
CMD ["node", "dist/bin.js"]
