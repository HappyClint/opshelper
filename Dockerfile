# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base

WORKDIR /app

# RUN apt-get update \
#   && apt-get install -y --no-install-recommends openssl ca-certificates dumb-init \
#   && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i \
            's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g; \
             s|http://security.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g; \
             s|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' \
            /etc/apt/sources.list.d/debian.sources; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        openssl \
        ca-certificates \
        dumb-init; \
    rm -rf /var/lib/apt/lists/*


FROM base AS deps

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY prisma/schema.prisma ./prisma/schema.prisma

RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline --no-audit --progress=false


FROM deps AS api

ENV NODE_ENV=production

COPY apps/api ./apps/api
COPY packages ./packages
COPY prisma ./prisma
COPY tsconfig.base.json ./
# Agent 与模型配置是部署数据，由管理员通过正式接口写入 data/；应用镜像不内置
# 共享 Agent，也不在启动时把模板写入用户运行环境。

EXPOSE 4000

CMD ["dumb-init", "npm", "run", "start", "-w", "@opshelper/api"]


FROM deps AS worker

ENV NODE_ENV=production

COPY apps/worker ./apps/worker
COPY packages ./packages
COPY prisma ./prisma
COPY tsconfig.base.json ./

CMD ["dumb-init", "npm", "run", "start", "-w", "@opshelper/worker"]


FROM deps AS web-builder

COPY apps/web ./apps/web
COPY packages ./packages
COPY tsconfig.base.json ./

RUN --mount=type=cache,target=/app/apps/web/.next/cache npm run build:web


FROM base AS web

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=web-builder /app/apps/web/.next/standalone ./
COPY --from=web-builder /app/apps/web/.next/static ./apps/web/.next/static
# standalone 输出不包含 public/，品牌图标等静态资源必须单独拷贝。
COPY --from=web-builder /app/apps/web/public ./apps/web/public

EXPOSE 3000

CMD ["dumb-init", "node", "apps/web/server.js"]
