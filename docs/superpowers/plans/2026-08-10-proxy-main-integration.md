# Proxy Main Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将无认证网络代理设置完整迁移到当前 `main`，同时保持本机免管理员认证和目标价永久删除。

**Architecture:** 以当前 `main` 为基线逐项移植 `codex/proxy-main-integration`，不执行直接 merge。代理设置持久化迁移改为 `0003_proxy_settings.sql`；运行时由单一出站网络层读取不可变代理快照，设置页只提交无认证 HTTP/HTTPS/SOCKS5 配置。

**Tech Stack:** Node.js 22、TypeScript、React、PostgreSQL 17、undici、Playwright、Vitest、Docker Compose、GitHub Actions。

## Global Constraints

- 不改写 `migrations/postgres/0001_initial.sql` 或 `0002_remove_target_price.sql`。
- 新代理迁移编号固定为 `0003_proxy_settings.sql`，不恢复任何目标价列、表、事件或 UI。
- 只支持无认证 HTTP、HTTPS、SOCKS5；拒绝用户名、密码与 URL 内嵌认证，且不记录真实代理地址。
- `LOCAL_DEVELOPMENT_AUTH_BYPASS=true` 仅在本机开发时放行认证；NAS/生产默认保留认证。
- 所有新增或修改的源代码、测试、SQL 和配置使用准确中文详细注释。
- 不覆盖或暂存用户已有的 `package.json`、`package-lock.json`、旧 NAS 设计文档和无关未跟踪文档。

---

### Task 1: 迁移和代理配置领域模型

**Files:**
- Create: `migrations/postgres/0003_proxy_settings.sql`
- Create: `src/shared/proxy-settings.ts`
- Modify: `src/shared/domain.ts`
- Modify: `test/postgres-migrations.test.ts`
- Create: `test/proxy-settings.test.ts`

**Interfaces:**
- Produces: `ProxySettings`、`ProxyProtocol` 与严格解析后的 `proxyUrl`；设置持久化后可选地保存协议、主机和端口。
- Consumes: 已存在的 `0002_remove_target_price.sql`，其后迁移不得引用目标价结构。

- [x] **Step 1: 写失败配置解析与迁移回归**

覆盖 HTTP/HTTPS/SOCKS5 有效值、空配置、非法端口、内嵌认证、用户名/密码字段，以及旧库依次应用 `0001`、`0002`、`0003` 后目标价结构仍不存在。

- [x] **Step 2: 运行红灯**

Run: `TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npx vitest run test/proxy-settings.test.ts test/postgres-migrations.test.ts`

Expected: FAIL，因为 `0003` 与代理解析器尚不存在。

- [x] **Step 3: 实现最小领域和迁移**

创建只保存协议、主机和端口的代理设置结构；`0003` 使用可重跑安全 SQL，不删除设置、订阅、价格或认证数据。将迁移账本数量、表/列快照和备份期望更新为三条迁移。

- [x] **Step 4: 运行绿灯**

Run: `TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npx vitest run test/proxy-settings.test.ts test/postgres-migrations.test.ts`

Expected: PASS；当前 `0002` 的目标价删除仍生效。

### Task 2: 设置仓储、服务、路由和认证旁路兼容

**Files:**
- Modify: `src/repositories/postgres/settings-repository.ts`
- Modify: `src/services/settings-service.ts`
- Modify: `src/routes/settings-routes.ts`
- Modify: `src/server/dependencies.ts`
- Modify: `test/postgres-settings-repository.test.ts`
- Create: `test/api-settings-proxy.test.ts`

**Interfaces:**
- Produces: `GET/PATCH /api/settings` 返回/接受代理公共 DTO，`POST /api/settings/proxy-test` 返回三态结果。
- Consumes: `localDevelopmentAuthBypass` 路由会话替身；设置验证不因旁路而放宽。

- [x] **Step 1: 写失败 API 回归**

在 `LOCAL_DEVELOPMENT_AUTH_BYPASS=true` 下无 Cookie 调用设置读取、代理保存和连接测试；断言密码字段、认证 URL 和越界端口返回 `422`，响应不回显秘密。

- [x] **Step 2: 运行红灯**

Run: `TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npx vitest run test/api-settings-proxy.test.ts test/postgres-settings-repository.test.ts`

Expected: FAIL，因为当前设置 DTO 与路由不含代理。

- [x] **Step 3: 移植设置边界**

移植代理字段的读取、保存与严格验证；只把现有受控会话替身传入设置路由，不能改变认证服务或 `LOCAL_DEVELOPMENT_AUTH_BYPASS` 的生产默认值。

- [x] **Step 4: 运行绿灯**

Run: `TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npx vitest run test/api-settings-proxy.test.ts test/postgres-settings-repository.test.ts`

Expected: PASS；本机可直接配置代理，默认认证配置不受影响。

### Task 3: 统一出站网络、Telegram 与 Playwright

**Files:**
- Create: `src/server/network/outbound-network.ts`
- Create: `src/server/network/proxy-agent-factory.ts`
- Create: `src/server/network/proxy-browser-probe.ts`
- Create: `src/server/network/proxy-errors.ts`
- Create: `src/services/proxy-connection-test-service.ts`
- Create: `src/services/proxy-telegram-service.ts`
- Create: `src/providers/playwright/browser-errors.ts`
- Modify: `src/providers/playwright/browser-launcher.ts`
- Modify: `src/providers/playwright/japanese-upgrade-browser.ts`
- Modify: `src/server/dependencies.ts`
- Create: `test/outbound-network.test.ts`
- Create: `test/proxy-agent-factory.test.ts`
- Create: `test/proxy-browser-probe.test.ts`
- Create: `test/proxy-connection-test-service.test.ts`
- Create: `test/proxy-telegram-service.test.ts`
- Modify: `test/playwright-browser-launcher.test.ts`

**Interfaces:**
- Produces: 幂等 HTTP 读取代理失败后一次直连回退、Telegram 结果不明不重发、Playwright 完整关闭后直连回退。
- Consumes: Task 2 保存的 `ProxySettings` 快照，不从请求或浏览器输入读取代理地址。

- [x] **Step 1: 写失败传输回归**

使用回环 HTTP/SOCKS5 夹具覆盖代理成功、连接拒绝后直连、目标响应不回退、Telegram 已发出时不重发、Playwright 关闭顺序和三态测试结果。

- [x] **Step 2: 运行红灯**

Run: `npx vitest run test/outbound-network.test.ts test/proxy-agent-factory.test.ts test/proxy-browser-probe.test.ts test/proxy-connection-test-service.test.ts test/proxy-telegram-service.test.ts test/playwright-browser-launcher.test.ts`

Expected: FAIL，因为当前运行时没有代理传输层。

- [x] **Step 3: 移植最小网络层**

所有代理 Agent 由协议、主机、端口构造；读取请求只在建连失败前回退一次，已收到 HTTP 响应不回退。Playwright 回退前关闭旧资源，Telegram 仅在请求未发出时回退。依赖装配只替换网络边界，不引入目标价通知类型。

- [x] **Step 4: 运行绿灯**

Run: `npx vitest run test/outbound-network.test.ts test/proxy-agent-factory.test.ts test/proxy-browser-probe.test.ts test/proxy-connection-test-service.test.ts test/proxy-telegram-service.test.ts test/playwright-browser-launcher.test.ts`

Expected: PASS；代理与直连边界均按安全合同执行。

### Task 4: 设置页代理卡片与客户端模型

**Files:**
- Modify: `src/app/settings-api-client.ts`
- Modify: `src/app/settings-form.ts`
- Modify: `src/app/settings-page.tsx`
- Modify: `test/settings-api-client.test.ts`
- Create: DOM 回归于现有设置页测试文件或新增 `test/settings-page-proxy.test.tsx`

**Interfaces:**
- Produces: 设置页无认证代理协议、主机、端口表单及连接测试三态反馈。
- Consumes: Task 2 的公开设置 DTO，页面不持久化测试草稿。

- [x] **Step 1: 写失败客户端与 DOM 回归**

断言代理卡片存在、没有用户名/密码控件、测试按钮不先保存草稿、代理成功/直连回退/失败均有明确文字。

- [x] **Step 2: 运行红灯**

Run: `npm run test:dom -- test/settings-api-client.test.ts test/settings-page-proxy.test.tsx`

Expected: FAIL，因为当前设置页未渲染代理卡片。

- [x] **Step 3: 移植页面与客户端 DTO**

页面只提交协议、主机、端口；空代理表示直连。连接测试使用服务端固定目标，不把错误原文、凭据或代理 URL 显示到界面。

- [x] **Step 4: 运行绿灯**

Run: `npm run test:dom`

Expected: PASS；设置页出现代理设置，订阅页仍无目标价控件。

### Task 5: Docker/CI、文档与总验证

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release-image.yml`
- Modify: `test/docker-config.test.mjs`
- Modify: `test/github-actions-release.test.mjs`
- Create: `test/proxy-container-contract.test.mjs`
- Create: `test/proxy-smoke.test.ts`
- Modify: `docs/README.md`、`docs/requirements/PRD.md`、`docs/requirements/traceability.md`、`docs/architecture/api-design.md`、`docs/architecture/data-model.md`、`docs/architecture/system-design.md`、`docs/quality/quality-and-acceptance.md`

**Interfaces:**
- Produces: CI 与标签发布均执行代理回环合同；活跃文档只描述无认证代理和当前三迁移账本。

- [x] **Step 1: 写失败容器、工作流与扫描回归**

验证 CI 和 release workflow 都运行代理传输测试；容器测试只使用回环代理夹具；扫描允许历史 `0001` 和目标价删除迁移证据，不允许当前运行时代码重新出现目标价。

- [x] **Step 2: 运行红灯**

Run: `npm run test:docker-config && npm run test:github-actions && npm run test:workflow-comments`

Expected: FAIL，因为当前工作流和容器合同不含代理步骤。

- [x] **Step 3: 同步合同与文档**

移植代理测试步骤和中文安全注释；文档注明无认证限制、失败回退和本机认证旁路边界。不得改写目标价删除历史或用户原有版本号改动。

- [x] **Step 4: 运行最终验证**

Run: `npx tsc --noEmit && TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test npx vitest run && npm run test:dom && npm run test:docker-config && npm run test:github-actions && npm run test:workflow-comments && npm run build && git diff --check`

Expected: 全部通过；当前 `main` 同时具备代理、本机免认证和无目标价。

- [ ] **Step 5: 提交（仅在获得用户明确确认后）**

提交前逐项排除用户既有版本号、代理旧文档与无关文件；获得确认后同一操作完成 `git commit -m "feat: integrate proxy settings on main"` 和 `git push origin main`。
