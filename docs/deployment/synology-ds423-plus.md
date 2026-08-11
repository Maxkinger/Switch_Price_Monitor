# Synology DS423+ 局域网部署

状态：操作手册已就绪；公开镜像和 NAS 实机部署尚未完成
适用范围：DS423+（`linux/amd64`）、Container Manager / Docker Compose、局域网 HTTP

## 1. 前置条件

- Docker Hub 中已经存在经 GitHub Actions 发布的公开双架构镜像；当前尚未发布，先完成 [Docker Hub 发布](docker-hub-release.md)。
- NAS 已安装 Container Manager，并有足够空间保存 PostgreSQL 数据、备份和约 1 GB Chromium 共享内存。
- 选定未被占用的局域网端口，例如 `3000`。生产只开放 app HTTP；不要为 PostgreSQL 增加 `ports`，不要开放 Chromium/CDP。
- 准备两个不同的随机长数据库密码。不得复用 NAS 管理员密码、Docker Hub token 或应用管理员密码。

本文使用以下固定目录；如需修改，必须在全部命令和 `.env` 中保持一致：

```text
/volume1/docker/switch-price-monitor/
├── docker-compose.prod.yml
├── .env
├── docker/postgres/init-app-role.sh
├── scripts/backup-postgres.sh
├── scripts/restore-postgres.sh
├── postgres-data/          # 首次启动前必须为空
└── backups/
```

## 2. 准备部署资产

从发布对应的 Git 提交复制以下部署资产到 NAS，目录层级不能改变：

- `docker-compose.prod.yml`
- `.env.example`（在 NAS 上复制为 `.env`）
- `docker/postgres/init-app-role.sh`
- `scripts/backup-postgres.sh`
- `scripts/restore-postgres.sh`

NAS 不需要源码、`node_modules`、Dockerfile 或构建工具。创建目录后，确认 `postgres-data` 是本项目专属空目录，不能指向 NAS 上其他 PostgreSQL 项目：

```bash
mkdir -p /volume1/docker/switch-price-monitor/docker/postgres
mkdir -p /volume1/docker/switch-price-monitor/scripts
mkdir -p /volume1/docker/switch-price-monitor/postgres-data
mkdir -p /volume1/docker/switch-price-monitor/backups
```

用 DSM 权限界面或 SSH 将项目目录限制为部署管理员可读写；至少将秘密文件设为仅所有者可读写、初始化脚本设为只读可执行：

```bash
chmod 600 /volume1/docker/switch-price-monitor/.env
chmod 500 /volume1/docker/switch-price-monitor/docker/postgres/init-app-role.sh
chmod 500 /volume1/docker/switch-price-monitor/scripts/backup-postgres.sh
chmod 500 /volume1/docker/switch-price-monitor/scripts/restore-postgres.sh
chmod 700 /volume1/docker/switch-price-monitor/postgres-data
chmod 700 /volume1/docker/switch-price-monitor/backups
```

不要把 `.env` 内容贴到终端历史、截图、工单或日志。先在安全编辑器中逐项替换公开占位：

- `DOCKERHUB_IMAGE`：公开仓库，例如 `namespace/switch-price-monitor`。
- `APP_VERSION`：精确已发布版本，例如 `0.1.0`；禁止 `latest`、`0.1` 或 `sha-*`。
- `APP_PORT`：局域网访问端口；`PORT` 通常保持 `3000`。
- `POSTGRES_USER` / `POSTGRES_PASSWORD`：仅数据库容器持有的 bootstrap 角色。
- `APP_DATABASE_USER` / `APP_DATABASE_PASSWORD`：普通应用数据库所有者；必须与 bootstrap 身份不同。
- `DATABASE_URL`：只使用普通应用角色，密码中的 `@`、`:`、`/`、`%` 等必须百分号编码，主机固定为 `postgres`。
- `POSTGRES_DATA_DIR=/volume1/docker/switch-price-monitor/postgres-data`。
- `BACKUP_DIR=/volume1/docker/switch-price-monitor/backups`、`BACKUP_RETENTION=14`。
- 局域网纯 HTTP 使用 `COOKIE_SECURE=false`。未来只在可信 HTTPS 已生效后改为 `true`。
- Telegram 两项必须同时为空或同时填写；设置页不能补录这两项秘密。
- `DEEPSEEK_API_KEY` 仅在此权限受控、未提交的私有 `.env` 中按需填写；空值会禁用 AI 名称建议但不影响手工名称确认，绝不能把 Key 复制到设置页、数据库、镜像、截图、工单或日志。未设置 `DEEPSEEK_MODEL` 时默认 `deepseek-v4-flash`；私有 `.env` 仅允许 `deepseek-v4-flash` 或 `deepseek-v4-pro`，其他值会在启动时以固定错误拒绝。

## 3. 首次启动

在项目目录执行。`config -q` 只校验配置，不应使用会展开并打印全部环境的命令保存日志：

```bash
cd /volume1/docker/switch-price-monitor
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor config -q
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor pull
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor up -d
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor ps
```

预期只有 `app` 与 `postgres`，两者最终为 `healthy`。首次空目录启动时，PostgreSQL 官方入口仅执行一次 init hook：bootstrap 角色创建普通应用数据库所有者，app 随后以普通角色执行版本化迁移。若数据目录非空但角色未初始化，健康检查会阻止 app 启动；不要反复改密码或手工补角色，应停止栈、保留现场并按“首次失败处理”使用一个确认无业务数据的新空目录重试。

只查看必要的脱敏日志，避免使用 `docker inspect`、`docker compose config` 或打印容器环境来排障：

```bash
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor logs --tail 100 app
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor logs --tail 100 postgres
```

日志中不应出现 `DATABASE_URL`、密码、DeepSeek API Key、Telegram Token、Chat ID、Cookie、恢复码、任天堂页面正文、DeepSeek 响应正文或浏览器会话信息。如出现，应先停止分享日志并按泄露流程轮换对应秘密。

## 4. 首次应用初始化

浏览器访问 `http://<NAS局域网IP>:<APP_PORT>/`：

1. 设置单一管理员密码，选择至少一个启用地区，并从中选择默认搜索区。
2. 系统只显示一次恢复码。立即保存到独立密码管理器，不截图、不写入 NAS `.env` 或数据库备份说明。
3. 明确确认恢复码已保存后进入应用，再退出并用密码重新登录一次。
4. 检查设置页、空仪表盘和手动刷新入口；真实任天堂样本与 Telegram 投递属于后续受控验收，当前尚未完成。

恢复码不会重发，当前也没有已登录后重新生成恢复码或绕过数据库校验的受支持 UI。若恢复码丢失但现有会话仍有效，应先保留该会话和可用备份，并制定受控的全新数据库重建或经验证备份恢复方案；不要退出唯一会话、直接修改 PostgreSQL 表或期望从镜像找回秘密。恢复码和管理员密码都无法从数据库、镜像或文档中取回。

## 5. 日常启动、停止与检查

```bash
cd /volume1/docker/switch-price-monitor
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor up -d
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor ps
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor stop
```

不要执行 `down -v`，生产使用 bind mount 且数据库不可随应用清理。关停前优先做一次验证备份。

## 6. 升级与回滚

升级前先完成 [PostgreSQL 备份](postgres-backup-restore.md)，再把 `.env` 中 `APP_VERSION` 改为已经发布的精确版本：

```bash
cd /volume1/docker/switch-price-monitor
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor config -q
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor pull app
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor up -d app
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor ps
```

回滚只允许回到文档声明与当前迁移账本兼容的上一个应用版本。先停止 app，将 `APP_VERSION` 改回上一个精确版本，重新 `pull app` 和 `up -d app`。如果新版本迁移不兼容旧应用，不得直接启动旧镜像；应按恢复手册在独立空库演练，从升级前备份恢复，再安排受控切换。

## 7. 当前未完成项

- 当前工作树已在 M1/arm64 完成生产镜像/Compose 运行时、认证持久性、端口隔离、镜像内 Chromium 与备份恢复 14/14 验收；业务 fake/fixture 由完整自动化分层验证。
- Docker Hub Secrets 尚未配置，`v0.1.0` 尚未创建，公开镜像尚未发布。
- DS423+ 实机部署、真实 Telegram 与任天堂样本验收尚未执行。
- 线上 Cloudflare 资源仍保留，必须另行授权后退役。
