# DSH 运行镜像：DSH + dsh-webapi 插件 + mono-color 技能 + APIMart MCP 图像服务
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DSH_HOME=/root/.dsh

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tar gzip \
 && rm -rf /var/lib/apt/lists/*

# dsh plugin 管理器依赖 pnpm（corepack 自带）
RUN corepack enable && corepack prepare pnpm@latest --activate

# 1) DSH；install-scripts 白名单与本机验证过的安装方式一致
#    （koffi/node-pty 等需要执行安装脚本，其余包脚本默认被 npm 拦截）
ARG DSH_VERSION=0.2.1-rc.5
RUN npm install -g \
      --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
      @deepseek-ai/dsh@${DSH_VERSION} \
 && dsh --version

# 2) profile `web` + dsh-webapi 插件（task.md 指定的 oddpan/dsh-webapi 实为 toddpan/dsh-webapi）
RUN dsh plugin --profile web add \
      https://github.com/toddpan/dsh-webapi/releases/latest/download/dsh-web-service.tgz

# 3) 可复用技能：mono-color-skill（SKILL.md 位于仓库根）
RUN mkdir -p /root/.dsh/skills \
 && curl -fsSL https://github.com/yanliudesign/mono-color-skill/archive/refs/heads/main.tar.gz \
      | tar -xz -C /tmp \
 && mv /tmp/mono-color-skill-main /root/.dsh/skills/mono-color-skill \
 && test -f /root/.dsh/profiles/web/package.json

# 3b) 仓库 skills/ 下的可复用技能（1104：5 个新技能随镜像分发）
COPY skills /root/.dsh/skills

# 4) APIMart 图像 MCP 服务（零依赖 stdio server）
COPY mcp-image /opt/mcp-image

# 5) 用户层配置补丁：dsh-web-service 鉴权 + mcp-image 注册
COPY docker/dsh/cordis.patch.yml /root/.dsh/profiles/web/cordis.patch.yml

COPY docker/dsh/entrypoint.sh /usr/local/bin/dsh-entrypoint.sh
RUN chmod +x /usr/local/bin/dsh-entrypoint.sh

EXPOSE 3080

# 存活探针：配置 apiKey 后连 UI 根路径也返回 401，故带 Bearer 调免登录的
# /api/v1/system/status；服务绑网卡 IP 而非回环，探针取同一块非回环 IPv4。
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "const ifs=require('os').networkInterfaces();let ip;for(const n of Object.keys(ifs))for(const i of ifs[n]||[])if(i.family==='IPv4'&&!i.internal&&!ip)ip=i.address;if(!ip)process.exit(1);const k=process.env.DSH_WEB_API_KEY||'';fetch('http://'+ip+':3080/api/v1/system/status',{headers:{authorization:'Bearer '+k}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["dsh-entrypoint.sh"]
