# 临时发布版本号 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在页面左侧导航显示由唯一版本清单提供的 `V x.y.z`，并让生产部署在构建前自动递增补丁号。

**Architecture:** `src/app/release-version.ts` 在 Vite 构建时导入根目录 `package.json`，向 React 应用壳暴露只读版本字符串。独立的 Node 发布脚本顺序执行 npm 的补丁版本递增、普通构建和 Wrangler 生产部署；它不创建 Git tag，不读取或传递任何秘密。

**Tech Stack:** React 19、Vite 7、TypeScript、Vitest/jsdom、Node.js、npm、Wrangler。

## Global Constraints

- 首个受本规则管理的根包版本固定为 `0.0.1`，导航显示格式固定为 `V 0.0.1`。
- `package.json` 是唯一版本来源；浏览器不得读取文件系统、调用版本 API 或维护第二份硬编码版本。
- `npm run dev`、`npm run build`、`npm test` 和 `npm run test:dom` 不得改写版本；仅生产 `npm run deploy` 可递增一次补丁号。
- 发布脚本必须依次运行 `npm version patch --no-git-tag-version`、构建和 `wrangler deploy`，且不创建自动 Git tag。
- 所有新增或修改的源代码、测试代码、配置和运行脚本均须带有与实现一致的中文详细注释；提交前需要检查注释与实现一致性。
- 任何 Git 提交前必须取得管理员明确确认；确认后在同一操作中提交并推送 `main`，不能仅本地提交。

---

### Task 1: 构建时版本模块与导航标识

**Files:**
- Create: `src/app/release-version.ts`
- Modify: `src/app/app-shell.tsx:1-57`
- Modify: `src/app/styles.css:796-800`
- Modify: `tsconfig.json:3-20`
- Modify: `package.json:1-13`
- Modify: `package-lock.json:1-9`
- Test: `test/app-shell-version.test.tsx`

**Interfaces:**
- Consumes: 根目录 `package.json` 的 `version: string`。
- Produces: `releaseVersion: string`；`AppShell` 将其作为 `V ${releaseVersion}` 输出到左侧导航底部。

- [x] **Step 1: 写入失败的页面版本测试**

创建 `test/app-shell-version.test.tsx`：

```tsx
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "../src/app/app-shell";

describe("应用壳发布版本", () => {
  afterEach(() => {
    // 每个用例恢复 DOM、fetch mock 与路由，避免仪表盘首屏请求残留而影响版本标识的独立断言。
    cleanup();
    vi.unstubAllGlobals();
    window.history.replaceState(null, "", "/");
  });

  it("shows the package release version at the bottom of the navigation", async () => {
    // 应用壳首屏会读取仪表盘；使用完整固定响应避免网络状态干扰导航中静态构建版本的验证。
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      stats: { monitoredSubscriptionCount: 0, availableRegionPriceCount: 0, lastCapturedAt: null, nextDailyReportAt: null },
      subscriptions: [],
    })));

    render(<AppShell onUnauthorized={vi.fn()} />);

    expect(await screen.findByText("V 0.0.1")).toBeVisible();
  });
});
```

- [x] **Step 2: 运行测试并确认失败原因是版本模块和导航标识尚不存在**

Run: `npm run test:dom -- test/app-shell-version.test.tsx`

Expected: FAIL，测试找不到 `V 0.0.1`；失败不能来自 fetch、jsdom 或无关的 TypeScript 错误。

- [x] **Step 3: 实现唯一版本模块与导航底部标识**

在 `tsconfig.json` 的 `compilerOptions` 增加 `"resolveJsonModule": true`，使 TypeScript 与 Vite 一致地将 JSON 清单作为构建输入。

创建 `src/app/release-version.ts`：

```ts
import packageManifest from "../../package.json";

/**
 * 发布版本只在 Vite 构建时从根包清单读取一次，避免浏览器请求文件系统或维护会与部署版本漂移的第二份字符串。
 * 该值仅供管理员核对页面发布批次，绝不用于认证、价格、D1 迁移或任何安全决策。
 */
export const releaseVersion: string = packageManifest.version;
```

在 `src/app/app-shell.tsx` 导入 `releaseVersion`，并将以下元素作为 `aside.monitor-nav` 的最后一个子元素：

```tsx
{/* 版本位于导航末尾，仅展示构建时公开版本，不包含提交号、环境变量或凭据。 */}
<small className="monitor-nav__version">V {releaseVersion}</small>
```

在 `src/app/styles.css` 新增：

```css
/* 版本标识利用 auto margin 固定在桌面导航底部；弱化颜色避免与可点击导航入口竞争，同时不隐藏发布批次信息。 */
.monitor-nav__version { margin-top: auto; padding: 18px 12px 0; color: #9a8375; font-size: 12px; }
```

在窄屏媒体查询增加 `.monitor-nav__version { margin-top: 0; padding: 6px 12px; white-space: nowrap; }`，使顶部横向导航不会产生无效的垂直撑开。

将 `package.json` 与 `package-lock.json` 根包的版本从 `0.1.0` 同步改为 `0.0.1`；这是已确认的临时版本起点，不改变任何依赖版本。

- [x] **Step 4: 运行页面测试、类型检查和构建**

Run: `npm run test:dom -- test/app-shell-version.test.tsx && npx tsc --noEmit && npm run build`

Expected: PASS；页面测试找到 `V 0.0.1`，普通构建不改写 `package.json` 或 `package-lock.json` 的版本。

### Task 2: 受控补丁递增生产部署脚本

**Files:**
- Create: `scripts/deploy-production.mjs`
- Modify: `package.json:5-13`
- Test: `test/deploy-production-script.test.mjs`

**Interfaces:**
- Consumes: `npm run deploy`、干净的已确认工作区、`npm` 与 `npx wrangler`。
- Produces: 依次运行补丁递增、构建、生产 Worker 部署的 Node 脚本；任一步返回非零状态即停止，后续步骤不运行。

- [x] **Step 1: 写入失败的发布脚本契约测试**

创建 `test/deploy-production-script.test.mjs`：

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production deploy script increments the patch before build and deployment", async () => {
  // 只检查受版本控制的发布契约，不执行脚本，避免测试自行改写版本号或向 Cloudflare 部署。
  const packageManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const script = await readFile(new URL("../scripts/deploy-production.mjs", import.meta.url), "utf8");

  assert.equal(packageManifest.scripts.deploy, "node ./scripts/deploy-production.mjs");
  assert.ok(script.indexOf('"version", "patch", "--no-git-tag-version"') < script.indexOf('"run", "build"'));
  assert.ok(script.indexOf('"run", "build"') < script.indexOf('"wrangler", "deploy"'));
});
```

- [x] **Step 2: 运行测试并确认失败原因是发布脚本尚不存在**

Run: `node --test test/deploy-production-script.test.mjs`

Expected: FAIL，提示找不到 `scripts/deploy-production.mjs` 或 `package.json` 尚未指向该脚本。

- [x] **Step 3: 实现停止于首个失败的发布脚本，并接入 npm 命令**

创建 `scripts/deploy-production.mjs`：

```js
import { spawnSync } from "node:child_process";

/**
 * 生产发布只能按“版本递增、构建、部署”的顺序执行；先递增让页面构建产物携带新批次，
 * 任何一步失败都会立即停止，避免在构建失败后仍错误发布旧资源。脚本不读取或打印任何 Secret。
 */
const releaseSteps = [
  ["npm", ["version", "patch", "--no-git-tag-version"]],
  ["npm", ["run", "build"]],
  ["npx", ["wrangler", "deploy"]],
];

for (const [command, argumentsList] of releaseSteps) {
  // inherit 保留 Wrangler 的正常认证交互；每次只运行一个固定命令，禁止拼接管理员输入防止命令注入。
  const result = spawnSync(command, argumentsList, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
```

将 `package.json` 的 `deploy` 改为：

```json
"deploy": "node ./scripts/deploy-production.mjs"
```

- [x] **Step 4: 验证发布契约和普通构建不会改变版本**

Run: `node --test test/deploy-production-script.test.mjs && npm run build && git diff -- package.json package-lock.json`

Expected: 契约测试 PASS；普通构建成功；最后一个命令不显示由构建造成的版本差异。不得执行 `npm run deploy`，因为它会按设计递增版本并发起真实生产部署，必须在管理员单独授权后才可运行。

### Task 3: 文档状态、完整质量门禁与提交确认

**Files:**
- Modify: `docs/README.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/superpowers/specs/2026-07-18-temporary-release-version-design.md`
- Modify: `docs/superpowers/plans/2026-07-18-temporary-release-version.md`

**Interfaces:**
- Consumes: Task 1 和 Task 2 的已验证实现。
- Produces: 标记为已实施的需求与规格记录，以及可供管理员确认的完整变更范围。

- [x] **Step 1: 更新文档中的实施状态与验收记录**

将规格状态改为“已实施，生产部署待管理员授权”；将 `FR-011` 状态改为“已确认 / 已实施（页面显示构建时版本，生产部署脚本先递增补丁号）”；将文档中心版本号规格状态改为“已实施，生产部署待授权”。在计划各任务与完成步骤前勾选 `- [x]`，并记录已运行的本地测试、类型检查和构建结果；不记录任何账号、Token、Cookie 或生产部署 URL。

- [x] **Step 2: 运行完整本地质量门禁**

Run: `npm test && npm run test:dom && npx tsc --noEmit && npm run build && git diff --check`

Expected: 所有 Worker、DOM、类型、构建和空白差异检查通过；评论与实现一致，普通构建不造成版本漂移。

- [ ] **Step 3: 请求管理员确认提交与推送**

说明将提交的范围：临时版本规格、实施计划、PRD/追踪、版本模块与导航样式、起始版本清单、发布脚本及其测试。仅在获得明确确认后运行：

```bash
git add docs/ package.json package-lock.json scripts/deploy-production.mjs src/app/release-version.ts src/app/app-shell.tsx src/app/styles.css tsconfig.json test/app-shell-version.test.tsx test/deploy-production-script.test.mjs
git commit -m "feat: show release version in navigation"
git push origin main
```

Expected: 同一操作完成本地提交与远程推送。生产 `npm run deploy` 不属于本次提交操作，仍必须在管理员另行授权后才可执行。

## 自检记录

- 规格覆盖：Task 1 覆盖唯一版本来源、`V 0.0.1` 显示和普通构建不递增；Task 2 覆盖发布前补丁递增、命令顺序和无 Git tag；Task 3 覆盖文档与完整质量门禁。
- 占位符检查：计划未使用待定版本、外部 URL、密钥或未定义的文件路径；所有新增导出和脚本名称均在对应任务中定义。
- 类型一致性：`releaseVersion` 只由 `release-version.ts` 导出，`AppShell` 只消费该字符串；部署脚本的命令契约由 Node 标准测试独立验证。
- 验证结果：失败测试先后确认缺少导航标识和缺少发布脚本；随后 Node 发布契约测试、56 个 Worker 测试文件共 179 项、4 个 DOM 测试文件共 8 项、TypeScript 检查、普通构建和 `git diff --check` 均通过。普通构建前后版本清单哈希一致。
