# GitHub Actions PostgreSQL 双角色初始化修复设计规格

## 1. 背景与根因

提交 `f0f2c3d` 的普通 GitHub Actions CI 在 435 项测试中通过 434 项，唯一失败为 `test/postgres-migrations.test.ts` 的应用角色权限断言。远程日志显示 `switch_test` 同时拥有超级用户、建角色、建库、复制和绕过 RLS 权限。

本地开发 Compose 以 `switch_test_admin` 引导全新 PostgreSQL，再由 `docker/postgres/init-app-role.sh` 创建无集群管理能力的 `switch_test`。两个 GitHub Actions 工作流却直接把 `POSTGRES_USER` 配置为 `switch_test`；官方 PostgreSQL 镜像会把该引导角色创建为超级用户，因此 CI 实际数据库权限模型与本地及生产模型不一致。发布工作流复用了同一错误配置，即使尚未由版本标签触发，也会在首次发布时同样失败。

## 2. 目标与非目标

### 2.1 目标

- 普通 CI 与标签发布门禁都必须以独立管理角色启动临时 PostgreSQL。
- 两个工作流必须复用仓库已有的 `docker/postgres/init-app-role.sh`，创建无超级权限的普通应用角色，避免维护第二份角色 SQL。
- 数据库迁移和全部 PostgreSQL 集成测试只能通过普通应用角色连接。
- 初始化后、测试前必须由普通角色自证可登录且不具备超级用户、建角色、建库、复制或绕过 RLS 权限。
- 所有用户名和密码都是一次性 CI 固定假值，不引用 GitHub Secrets，也不对应 NAS 或其他数据库。

### 2.2 非目标

- 不修改生产 Compose、开发 Compose、PostgreSQL 初始化脚本的执行逻辑或业务迁移；新增调用方式必须同步修正脚本职责注释，保证注释与实现一致。
- 不创建自定义 PostgreSQL CI 镜像，不引入新的镜像发布链。
- 不重试或弱化失败的权限断言；权限模型错误必须继续阻止普通 CI 和镜像发布。
- 不创建版本标签、不登录 Docker Hub，也不推送镜像。

## 3. 方案选择

采用“检出后向 service 容器执行现有初始化脚本”的方案。

GitHub Actions service 容器早于代码检出启动，不能直接绑定尚不存在的工作区脚本。GitHub 官方 `job.services.<service_id>.id` 上下文提供当前 service 容器 ID，因此每个 quality job 在 checkout 后执行以下数据流：

1. PostgreSQL service 以 `switch_test_admin`、独立管理密码和 `switch_test` 数据库启动；初始 healthcheck 只验证管理角色和数据库已可接收连接。
2. checkout 取得 `docker/postgres/init-app-role.sh`。
3. 初始化步骤通过 `${{ job.services.postgres.id }}` 定位 service 容器，把现有脚本经标准输入交给容器内 Bash 执行。脚本从容器环境读取管理角色与普通角色的固定 CI 假值，在单事务内创建 `switch_test` 并转移数据库与 `public` schema 所有权。
4. 同一步骤随后从容器内部以 `switch_test` 建立 TCP 连接，查询 `current_user` 和 `pg_roles`；只有角色可登录且五项集群级权限全部为 false 时才成功。
5. 测试步骤继续使用受 `requireTestDatabaseUrl()` 限制的 `127.0.0.1:54329`，连接用户保持 `switch_test`。

不采用工作流内联 SQL，因为这会复制安全关键的角色创建和所有权转移逻辑；不采用自定义 CI 数据库镜像，因为本次只需修复临时 service 初始化，新增镜像供应链不符合最小改动原则。

## 4. 安全与失败边界

- 管理角色与应用角色的名称和密码必须分别不同；合同测试要阻止未来把二者重新合并。
- 管理密码只存在于临时 service 容器环境，不进入应用测试 URL、日志、GitHub Secrets 或 Docker Hub 流程。
- 初始化命令不得打印环境值；现有脚本只输出固定变量名错误，并使用 `psql` 环境和元命令安全传递密码。
- service 的初始 `pg_isready` 只证明数据库已启动，不能替代应用角色权限自检。
- 初始化脚本、普通角色权限自检或测试任一失败时，quality job 立即停止；发布 job 因依赖 quality 成功，不得进入 Docker Hub 登录。
- PostgreSQL 仍只把 runner 的 `54329` 映射到临时容器 `5432`，保持测试破坏性 schema 重置的安全守卫。

## 5. 测试设计

先修改 `test/github-actions-release.test.mjs` 并验证 RED。合同必须同时覆盖普通 CI 和发布 quality job，检查：

- `POSTGRES_USER` 为管理角色，`APP_DATABASE_USER` 为 `switch_test`，两者名称和密码均不相同；
- service healthcheck 使用管理角色，不错误依赖尚未创建的应用角色；
- checkout 后存在唯一的应用角色初始化步骤，并位于 `unit_and_integration` 前；
- 初始化步骤从 `${{ job.services.postgres.id }}` 取得容器 ID，执行仓库现有初始化脚本，并包含普通角色集群权限自检；
- `TEST_DATABASE_URL` 仍精确使用普通角色与受守卫端口；
- 普通 CI 仍不得引用任何 Secrets，发布的 Docker Hub 登录边界不得改变。

测试的目标变异是：把 service 用户改回应用用户、删除初始化脚本执行、跳过权限自检、把初始化放到测试之后，或让测试 URL 使用管理角色；任一变异都必须使合同失败。

GREEN 后运行 Actions 合同、工作流中文注释检查、`actionlint`、完整 Vitest、类型检查、生产构建和差异检查。提交并推送后等待新普通 CI 完成；只有远程 workflow 全部通过，才关闭本次修复。

## 6. 交付范围

- 修改 `.github/workflows/ci.yml`。
- 修改 `.github/workflows/release-image.yml`。
- 仅修改 `docker/postgres/init-app-role.sh` 的职责注释，说明 Compose initdb 与全新 CI service 两种一次性调用边界；不修改 SQL 或执行逻辑。
- 修改 `test/github-actions-release.test.mjs`。
- 修改 `docs/quality/quality-and-acceptance.md`，记录远程失败、根因、RED/GREEN 与远程复验结果。
- 新增本设计规格及后续实施计划，并更新 `docs/README.md` 索引。
