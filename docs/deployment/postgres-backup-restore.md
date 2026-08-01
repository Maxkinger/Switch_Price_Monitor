# PostgreSQL 备份与空库恢复

状态：脚本与本地隔离门禁已完成；NAS 实机演练待执行

## 1. 安全边界

- 只使用 `scripts/backup-postgres.sh` 和 `scripts/restore-postgres.sh`，env、Compose、项目/备份/归档路径以及 Compose project、服务名和数据库名都显式传参；不依赖计划任务 cwd 自动发现 `.env`。
- PostgreSQL 17 的 `pg_dump`/`pg_restore` 在数据库容器内运行，宿主无需安装客户端，密码不进入宿主命令参数。
- 备份文件包含认证摘要、业务记录和可能敏感的诊断数据，按秘密数据管理；目录权限建议 `700`，脚本 `umask 077`。
- 默认保留最近 14 个成功归档；允许范围为 1..10000。保留顺序按每库 18 位单调 sequence，不依赖可修改的 mtime。
- 恢复绝不使用 `--clean`，绝不覆盖在线数据库。app 必须为 `exited/dead`，目标必须是独立 Compose project 的 app 角色所有空库。

以下示例沿用生产目录：

```text
项目根：/volume1/docker/switch-price-monitor
Compose：/volume1/docker/switch-price-monitor/docker-compose.prod.yml
备份目录：/volume1/docker/switch-price-monitor/backups
数据库：switch_price_monitor
project：switch-price-monitor
```

## 2. 创建备份

先确认两个服务健康，再执行：

```bash
/volume1/docker/switch-price-monitor/scripts/backup-postgres.sh \
  --compose-file /volume1/docker/switch-price-monitor/docker-compose.prod.yml \
  --env-file /volume1/docker/switch-price-monitor/.env \
  --project-name switch-price-monitor \
  --database-service postgres \
  --database switch_price_monitor \
  --project-root /volume1/docker/switch-price-monitor \
  --backup-dir /volume1/docker/switch-price-monitor/backups \
  --retention 14
```

部署 NAS 时必须把仓库中的两个脚本复制到 `/volume1/docker/switch-price-monitor/scripts/` 并按群晖部署手册设为部署管理员只读可执行；没有这两个版本匹配的脚本不得启用备份任务。脚本会：

1. 校验 env/Compose 等绝对路径、项目边界、标识和 Compose 配置。
2. 获取当前数据库的原子目录锁，拒绝同库并发备份。
3. 将 custom archive 流入同目录受限临时文件。
4. 在 PostgreSQL 17 容器内运行 `pg_restore --list` 校验。
5. 原子改名为 `switch-price-monitor-<database>-<18位sequence>-<UTC>.dump`。
6. 只清理同一数据库、符合固定命名合同且超出保留数的普通文件。

成功输出只有最终归档绝对路径。失败时旧备份保持不变；不要把 stderr 连同环境变量或 Compose 展开结果打包分享。

## 3. 定期备份

可用 DSM 任务计划程序调用上方完整命令，运行身份必须只能访问本项目目录和 Docker。任务可以从任意工作目录启动，因为脚本的每个 Compose 子命令都使用已校验的绝对 `--env-file`；不要 `source`、打印或把 `.env` 内容嵌入任务命令。建议至少每日一次，并定期把受限归档复制到独立存储；复制后的介质需要同等级访问控制和生命周期策略。

任务成功不等于可恢复。每次应用大版本升级前和至少按月执行一次下述独立空库恢复演练。

## 4. 准备独立恢复项目

恢复必须使用不同 Compose project 和新的空数据目录，例如：

```text
/volume1/docker/switch-price-monitor-restore/
├── docker-compose.prod.yml
├── .env
├── docker/postgres/init-app-role.sh
└── postgres-data/          # 必须为空且不得与生产目录重叠
```

复制生产部署资产，但为恢复项目设置新的 `POSTGRES_DATA_DIR`，使用新的 bootstrap/app 密码；`DOCKERHUB_IMAGE` 与 `APP_VERSION` 必须与备份迁移 manifest 对应。恢复 app 端口设为未占用端口，但恢复期间不要启动 app。

```bash
mkdir -p /volume1/docker/switch-price-monitor-restore/docker/postgres
mkdir -p /volume1/docker/switch-price-monitor-restore/postgres-data
chmod 700 /volume1/docker/switch-price-monitor-restore/postgres-data
cd /volume1/docker/switch-price-monitor-restore
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor-restore config -q
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor-restore pull
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor-restore up -d postgres
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor-restore ps
```

确认恢复项目 `postgres` healthy，且 `app` 未创建或处于 `exited/dead`。不要对生产 project 执行恢复命令。

## 5. 执行空库恢复

将 `<DUMP>` 替换为备份目录内的受控 `.dump` 绝对路径：

```bash
/volume1/docker/switch-price-monitor/scripts/restore-postgres.sh \
  --compose-file /volume1/docker/switch-price-monitor-restore/docker-compose.prod.yml \
  --env-file /volume1/docker/switch-price-monitor-restore/.env \
  --project-name switch-price-monitor-restore \
  --app-service app \
  --database-service postgres \
  --project-root /volume1/docker/switch-price-monitor \
  --backup-dir /volume1/docker/switch-price-monitor/backups \
  --dump <DUMP> \
  --database switch_price_monitor
```

脚本在写入前两次确认 app 已停止，验证目标由普通 app 角色拥有且没有用户对象，校验归档和应用镜像迁移 manifest，然后以 `--single-transaction --exit-on-error --no-owner --no-privileges` 恢复。成功后还会验证：

- 迁移账本非空且与镜像文件名/校验和完全一致。
- public 表集合与当前迁移精确一致，共 16 张：`schema_migrations`、`settings`、`games`、`regional_products`、`subscriptions`、`subscription_regions`、`subscription_region_targets`、`price_snapshots`、`exchange_rates`、`fetch_logs`、`regional_product_health`、`notification_events`、`admin_credentials`、`sessions`、`login_attempts`、`manual_refresh_requests`；缺表或额外旧表均拒绝。
- 管理员记录为 0 行，或只有唯一 `id=1`。

post-validation 失败时，脚本只清理这个已证明为空且仍持锁的显式目标数据库，重新证明为空后才允许重试；它不会修改生产数据库、其他数据库、表空间或角色级共享授权。

## 6. 恢复后验证与切换

恢复成功后才启动独立项目的 app：

```bash
cd /volume1/docker/switch-price-monitor-restore
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor-restore up -d app
docker compose --env-file .env -f docker-compose.prod.yml -p switch-price-monitor-restore ps
```

在隔离端口验证健康、登录、设置、订阅与历史读取。不要在同一浏览器标签混用生产与恢复项目 Cookie。演练完成后可停止恢复项目；删除恢复数据目录属于破坏性操作，必须先确认目标和保留要求。

真正灾难切换前，应先停止生产 app、保留生产数据目录和最后备份，再由管理员明确决定网络端口/目录切换。恢复脚本本身不会替换生产目录，也不会授权删除故障库。
