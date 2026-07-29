# syntax=docker/dockerfile:1.7

# Node 22 与服务端 tsup 目标一致；Bookworm 是 Playwright 支持的 glibc Debian，禁止改用缺少官方浏览器支持的 Alpine。
FROM node:22-bookworm-slim AS dependencies
WORKDIR /app

# 依赖层只复制清单并执行 lockfile 驱动的完整安装，确保 M1 arm64 与 DS423+ amd64 都由 BuildKit 当前平台解析原生包。
COPY package.json package-lock.json ./
RUN npm ci

# 构建层显式复制前后端所需输入；不使用 COPY .，从源头避免测试、文档、Git 元数据或本地秘密进入中间层。
FROM dependencies AS build
COPY index.html tsconfig.json tsup.config.ts vite.config.ts ./
COPY src ./src
RUN npm run build

# 生产依赖独立安装，不能从完整依赖层删除 dev 包后复用，以免 npm prune 留下不可审计的构建期文件。
FROM node:22-bookworm-slim AS production-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

# 最终层仍使用同一 Node 22 glibc 基础；Playwright 根据当前 BuildKit 平台安装与精确 npm 版本匹配的 Chromium，不拼接架构 URL。
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/home/app \
    XDG_CACHE_HOME=/home/app/.cache \
    TMPDIR=/tmp/switch-price-monitor
WORKDIR /app

# 先复制精简生产依赖，随后由锁定的 playwright 1.62.0 CLI 安装 Chromium 与 Debian 系统依赖；tini 负责回收 Node/Chromium 子进程。
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=production-dependencies /app/package-lock.json ./package-lock.json
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && npx --no-install playwright install --with-deps chromium \
    && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}" \
    && rm -rf /var/lib/apt/lists/*

# 固定 UID/GID 让群晖权限可预测；HOME、缓存和临时目录只交给应用用户写，浏览器安装目录保持全局只读。
RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/app --shell /usr/sbin/nologin app \
    && mkdir -p /home/app/.cache /tmp/switch-price-monitor \
    && chown -R 10001:10001 /home/app /tmp/switch-price-monitor

# 运行镜像只接收双构建产物、不可变 PostgreSQL 迁移和启动所需 package 元数据；源码、测试、env、文档和本地数据均不复制。
COPY --from=build /app/dist/client ./dist/client
COPY --from=build /app/dist/server ./dist/server
COPY migrations/postgres ./migrations/postgres

# 镜像仅声明应用 HTTP 默认端口；PostgreSQL、Chromium/CDP 或调试端口绝不能出现在运行镜像合同中。
EXPOSE 3000

# 健康检查只访问容器回环 API，不遍历或输出环境变量；失败只用退出码通知容器运行时。
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "const p=process.env.PORT||'3000';fetch('http://127.0.0.1:'+p+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

USER 10001:10001
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/index.js"]
