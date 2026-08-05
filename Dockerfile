# 构建阶段安装完整锁定依赖并生成客户端、Node 服务和 Chromium；代理配置不通过构建参数或环境变量注入。
FROM node:22-bookworm-slim AS build

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
# npm ci 使用 lockfile，保证代理 Agent、Playwright 与运行时代码版本在 M1/NAS 构建中一致。
RUN npm ci
COPY . .
RUN npm run build
# Chromium 只在镜像层安装浏览器二进制和系统库；业务代理仍由 PostgreSQL 设置页按请求快照决定。
RUN npx playwright install --with-deps chromium && chown -R node:node /ms-playwright

# 运行阶段使用非 root 用户；PostgreSQL 数据保存在独立容器，应用容器不需要 Docker Socket、host 网络或特权。
FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV STATIC_DIRECTORY=/app/dist/client
ENV MIGRATIONS_DIRECTORY=/app/migrations/postgres
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/migrations ./migrations
COPY --from=build --chown=node:node /app/index.html ./index.html
# 运行阶段仍需安装 Chromium 系统库；构建阶段的 apt 层不会跨多阶段镜像自动继承，遗漏会让 NAS 首次 Browser Run 启动失败。
USER root
RUN npx playwright install --with-deps chromium && chown -R node:node /ms-playwright
USER node

# 健康检查只访问容器自身 API，不依赖任天堂、Telegram、汇率服务或管理员代理可用性。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then((r)=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.js"]
