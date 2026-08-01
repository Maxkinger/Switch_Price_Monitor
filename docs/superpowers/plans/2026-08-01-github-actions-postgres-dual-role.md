# GitHub Actions PostgreSQL 双角色初始化修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复普通 CI 与标签发布 quality job 把应用测试角色创建成 PostgreSQL 超级用户的问题，使远程 435 项测试在与本地、NAS 一致的双角色权限模型下通过。

**Architecture:** 两个工作流的 PostgreSQL service 只用 `switch_test_admin` 引导临时数据库，并把普通应用角色假值放入容器环境。checkout 后通过 GitHub 官方 `job.services.postgres.id` 定位 service 容器，把仓库唯一的 `docker/postgres/init-app-role.sh` 经标准输入交给容器执行；初始化步骤随后以 `switch_test` 通过 TCP/SCRAM 自证可登录且没有五项集群级权限，测试 URL 始终只使用该普通角色。

**Tech Stack:** GitHub Actions YAML、PostgreSQL 17.10、Docker service containers、Bash、Node.js 22、`node:test`、`yaml`、Vitest。

## Global Constraints

- 必须先修改合同测试并观察它因现有超级用户配置而 RED，再修改工作流。
- 普通 CI 与发布 quality job 必须保持同一数据库初始化结构；任一工作流漂移都应使合同失败。
- 必须复用 `docker/postgres/init-app-role.sh`；禁止在工作流中复制 `CREATE ROLE` 或所有权转移 SQL。
- `switch_test_admin` 与 `switch_test` 的名称和密码必须分别不同；这些值只是临时 CI 假值，不得替换成 GitHub Secrets 或 NAS 凭据。
- `TEST_DATABASE_URL` 必须保持 `postgres://switch_test:switch_test@127.0.0.1:54329/switch_test`，继续满足破坏性测试安全守卫。
- 初始化、权限自检和测试任何一步失败都必须停止 quality job；发布 job 不能因此进入 Docker Hub 登录。
- 所有新增或修改的测试、工作流和运行配置必须有中文详细注释，并同步更新质量文档。
- 不创建 Git 标签、不登录或推送 Docker Hub、不访问 NAS 或 Cloudflare。
- 提交前必须列出精确范围并取得用户确认；确认后在同一操作中 commit 与 push。

---

### Task 1: 让两个 GitHub Actions quality job 使用双角色 PostgreSQL

**Files:**
- Modify: `test/github-actions-release.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release-image.yml`
- Modify: `docker/postgres/init-app-role.sh`（只同步两种一次性调用方式的职责注释，不修改 SQL 或执行逻辑）
- Modify: `docs/quality/quality-and-acceptance.md`
- Modify: `docs/README.md`
- Modify: `docs/superpowers/specs/2026-08-01-github-actions-postgres-dual-role-design.md`（只把脚本非目标与交付范围修正为“执行逻辑不变、职责注释同步”）
- Create: `docs/superpowers/plans/2026-08-01-github-actions-postgres-dual-role.md`

**Interfaces:**
- Consumes: `docker/postgres/init-app-role.sh` 的 `POSTGRES_DB`、`POSTGRES_USER`、`POSTGRES_PASSWORD`、`APP_DATABASE_USER`、`APP_DATABASE_PASSWORD` 环境合同。
- Consumes: GitHub `job.services.postgres.id` 字符串上下文和现有 `assertPostgresAndBrowserGate(job)` 合同入口。
- Produces: `initialize_postgres_role` 工作流步骤；该步骤在 checkout 后、`unit_and_integration` 前创建并验证普通应用角色。
- Produces: 两份 quality job 一致的 `switch_test_admin → switch_test` 临时权限模型。

- [ ] **Step 1: 写入能捕获远程失败的合同测试**

在 `assertPostgresAndBrowserGate(job)` 中增加下列行为合同，并把普通 CI 的精确步骤序列在 `checkout` 后加入 `initialize_postgres_role`：

```javascript
const postgresEnvironment = job?.services?.postgres?.env;
assert.equal(postgresEnvironment.POSTGRES_DB, "switch_test");
assert.equal(postgresEnvironment.POSTGRES_USER, "switch_test_admin");
assert.equal(postgresEnvironment.POSTGRES_PASSWORD, "switch_test_admin");
assert.equal(postgresEnvironment.APP_DATABASE_USER, "switch_test");
assert.equal(postgresEnvironment.APP_DATABASE_PASSWORD, "switch_test");
assert.notEqual(
  postgresEnvironment.POSTGRES_USER,
  postgresEnvironment.APP_DATABASE_USER,
  "CI bootstrap 管理角色不得与应用迁移角色合并",
);
assert.notEqual(
  postgresEnvironment.POSTGRES_PASSWORD,
  postgresEnvironment.APP_DATABASE_PASSWORD,
  "CI 管理密码与应用密码必须保持不同的临时假值",
);
assert.match(
  job.services.postgres.options,
  /pg_isready -U switch_test_admin -d switch_test/,
  "service 启动健康检查必须使用初始化时已存在的管理角色",
);

const stepSequence = stepIds(job);
const checkoutIndex = stepSequence.indexOf("checkout");
const initializeIndex = stepSequence.indexOf("initialize_postgres_role");
const testIndex = stepSequence.indexOf("unit_and_integration");
assert.ok(
  checkoutIndex >= 0 && checkoutIndex < initializeIndex && initializeIndex < testIndex,
  "应用角色初始化必须在检出脚本之后、PostgreSQL 测试之前",
);

const initializeRole = findStep(job, "initialize_postgres_role");
assert.equal(
  initializeRole.env.POSTGRES_SERVICE_ID,
  "${{ job.services.postgres.id }}",
);
assert.match(
  initializeRole.run,
  /docker exec --interactive "\$\{POSTGRES_SERVICE_ID\}" bash -s < docker\/postgres\/init-app-role\.sh/,
);
assert.match(initializeRole.run, /APP_DATABASE_PASSWORD/);
assert.match(initializeRole.run, /rolcanlogin/);
assert.match(initializeRole.run, /rolsuper/);
assert.match(initializeRole.run, /rolcreaterole/);
assert.match(initializeRole.run, /rolcreatedb/);
assert.match(initializeRole.run, /rolreplication/);
assert.match(initializeRole.run, /rolbypassrls/);
```

中文测试注释必须说明：目标变异是工作流再次让 `switch_test` 成为官方镜像 bootstrap 超级用户，或跳过初始化后普通角色自检。

- [ ] **Step 2: 运行合同并确认 RED 原因精确**

Run:

```bash
npm run test:github-actions
```

Expected: FAIL；现有两个 quality job 的 `POSTGRES_USER` 实际为 `switch_test`，缺少 `APP_DATABASE_USER` 和 `initialize_postgres_role`。失败不得来自 YAML 解析、拼写或缺失文件。

- [ ] **Step 3: 最小修改普通 CI 的 PostgreSQL service 与初始化步骤**

把 `.github/workflows/ci.yml` 的 service 环境改为：

```yaml
env:
  # 管理角色只负责官方镜像 initdb；普通测试连接永远不能获得它的集群级权限。
  POSTGRES_DB: switch_test
  POSTGRES_USER: switch_test_admin
  POSTGRES_PASSWORD: switch_test_admin
  # 应用角色由检出后的唯一 init hook 创建；固定假值只属于一次性 runner，不对应任何真实数据库。
  APP_DATABASE_USER: switch_test
  APP_DATABASE_PASSWORD: switch_test
```

把 health command 改为 `pg_isready -U switch_test_admin -d switch_test`。在 checkout 后加入：

```yaml
- name: 初始化并验证最小权限 PostgreSQL 应用角色
  id: initialize_postgres_role
  # service 早于 checkout 启动；官方 job context 提供容器 ID，使现有 init hook 可在取得源码后执行而无需复制 SQL。
  env:
    POSTGRES_SERVICE_ID: ${{ job.services.postgres.id }}
  shell: bash
  run: |
    set -Eeuo pipefail
    docker exec --interactive "${POSTGRES_SERVICE_ID}" bash -s < docker/postgres/init-app-role.sh

    # 通过 GitHub service 网络别名 postgres 进入 SCRAM host 规则，避免 loopback trust 把错误密码或错误角色误报为安全。
    role_is_safe="$(
      docker exec "${POSTGRES_SERVICE_ID}" bash -c '
        PGPASSWORD="${APP_DATABASE_PASSWORD}" psql \
          --host postgres \
          --username "${APP_DATABASE_USER}" \
          --dbname "${POSTGRES_DB}" \
          --no-psqlrc \
          --tuples-only \
          --no-align \
          --command "SELECT rolcanlogin AND NOT (
            rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls
          ) FROM pg_roles WHERE rolname = current_user"
      ' | tr -d '[:space:]'
    )"
    test "${role_is_safe}" = "t"
```

保持 `unit_and_integration.env.TEST_DATABASE_URL` 不变。

同步更新 `docker/postgres/init-app-role.sh` 顶部中文职责注释：脚本既用于生产/开发 Compose 的全新空目录 initdb，也用于 GitHub Actions 全新 service 在 checkout 后的一次性执行；脚本非幂等，已有应用角色时必须失败，不能静默改写角色或所有权。不得修改其 SQL 或执行逻辑。

- [ ] **Step 4: 对发布 quality job 应用完全相同的最小修复**

在 `.github/workflows/release-image.yml` 使用与 Step 3 相同的五个 service 环境变量、管理角色 healthcheck 和 `initialize_postgres_role` 步骤。初始化必须仍发生在任何 Docker Hub 登录之前；publish job、版本守卫、scope、标签和 Buildx 配置不得改变。

- [ ] **Step 5: 运行 GREEN 与工作流静态门禁**

Run:

```bash
npm run test:github-actions
npm run test:workflow-comments
actionlint .github/workflows/ci.yml .github/workflows/release-image.yml
git diff --check
```

Expected: Actions 合同 9/9、中文注释 1/1，`actionlint` 和差异检查退出 0。若 ShellCheck 报告未引用变量，删除无行为变量，不得用禁用规则掩盖。

- [ ] **Step 6: 运行完整本地回归**

确认开发 PostgreSQL Compose healthy 后执行：

```bash
TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npx vitest run
npm run test:dom -- --run
npx tsc --noEmit
npm run build
npm run test:docker-config
npx vitest run test/playwright-browser-launcher.test.ts
```

Expected: 完整 435 项、DOM 16 项、类型、生产构建、Docker 合同 14/14 和 Chromium 4 项全部通过。若测试计数因本任务新增合同而变化，只记录实际输出，不复制旧数字。

- [ ] **Step 7: 更新质量记录与文档状态**

在 `docs/quality/quality-and-acceptance.md` 新增 2026-08-01 小节，记录：

- 远程 run `30510098237` 为 434/435，失败角色五项集群权限均为 true；
- 本地与 CI 的差异是官方 `POSTGRES_USER` bootstrap 语义，不是 PostgreSQL 测试随机失败；
- 合同 RED、工作流最小修复、GREEN 和完整本地门禁的真实计数；
- 初始化复用现有 hook、没有真实秘密、Docker Hub 登录、镜像推送、Git 标签、NAS 或 Cloudflare 写入；
- 远程新 run 的 URL、结论和 job 计数只能在实际完成后填写。

把 `docs/README.md` 中本设计规格状态从“已确认，待实施”更新为与实际阶段一致；远程 CI 通过前不得写“已完成”。

- [ ] **Step 8: 范围审查并请求提交确认**

Run:

```bash
git status --short
git diff --check
git diff -- .github/workflows/ci.yml \
  .github/workflows/release-image.yml \
  docker/postgres/init-app-role.sh \
  test/github-actions-release.test.mjs \
  docs/quality/quality-and-acceptance.md \
  docs/README.md \
  docs/superpowers/specs/2026-08-01-github-actions-postgres-dual-role-design.md \
  docs/superpowers/plans/2026-08-01-github-actions-postgres-dual-role.md
```

Expected: 只有本计划列出的文件；设计规格相对 `aa39cce` 只同步“init hook 执行逻辑不变、职责注释需覆盖新增 CI 调用”这一范围说明。向用户报告 RED/GREEN 和完整验证证据，取得明确确认后才执行下一步。

- [ ] **Step 9: 在同一操作提交并推送**

用户确认后执行精确暂存，不能用无范围审查的 `git add -A`：

```bash
git add .github/workflows/ci.yml \
  .github/workflows/release-image.yml \
  docker/postgres/init-app-role.sh \
  test/github-actions-release.test.mjs \
  docs/quality/quality-and-acceptance.md \
  docs/README.md \
  docs/superpowers/specs/2026-08-01-github-actions-postgres-dual-role-design.md \
  docs/superpowers/plans/2026-08-01-github-actions-postgres-dual-role.md
git diff --cached --check
git commit -m "fix: 统一 CI PostgreSQL 角色模型"
git push origin codex/nas-docker-postgresql
```

- [ ] **Step 10: 等待并核验远程 CI**

使用 `gh run list` 找到上述新提交的普通 CI run，再用 `gh run view` 等待结束并读取 job。Expected：`完整质量门禁` conclusion 为 `success`，所有后续步骤实际执行，不能只依据本地通过宣称远程修复完成。

如果新 run 失败，先读取失败日志并重新进入系统化调试；不得直接重跑来掩盖确定性配置问题。远程通过后才把质量记录与 README 状态更新为“已完成”，若这需要新的文档提交，仍须按项目规则再次取得提交并推送确认。
