# PostgreSQL 登录失败状态原子 Upsert 修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用确定性真实 PostgreSQL 回归测试证明并修复成功登录删除失败状态时，并发登录可能读取不到 `login_attempts` 单例行的竞态。

**Architecture:** 保持 `admin_credentials -> login_attempts` 加锁顺序、认证端口和事务边界不变，只把 PostgreSQL 仓储内“`INSERT ... DO NOTHING` 后再 `SELECT ... FOR UPDATE`”合并为一条 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`。测试包装 `AppDatabase` 只协调两条真实事务的查询到达顺序，不模拟 SQL 结果、不替换 PostgreSQL 锁，也不采集任何查询参数。

**Tech Stack:** TypeScript 5.8、Vitest 4、Node.js 22、PostgreSQL 17、`pg`、Docker Compose。

## Global Constraints

- 系统仍只有 `id = 1` 的单一管理员凭据和单一登录失败状态。
- 登录与密码恢复继续遵循 `admin_credentials -> login_attempts` 的统一加锁顺序。
- 活跃锁定必须在 PBKDF2 密码校验前返回；五个并发错误请求全部完成后，后续正确密码必须被拒绝。并发请求之间不假定客户端数组顺序等于 PostgreSQL 锁授予顺序。
- 合法登录删除失败状态和写入会话摘要必须继续处于同一个真实 PostgreSQL 事务。
- 不新增或修改数据库迁移、D1 仓储、认证端口、HTTP API、页面、Cookie、会话格式、失败阈值、锁定时长、PBKDF2 参数或恢复码规则。
- 所有新增或修改的源代码、测试和运行配置必须包含中文详细注释，说明职责、锁顺序、边界条件以及安全或业务原因，并在验证时检查注释与实现一致。
- 测试不得打印、快照化或持久化密码、哈希、盐、原始会话令牌、恢复码和数据库真实凭据。
- PostgreSQL 集成测试只能使用 `postgres://switch_test:switch_test@127.0.0.1:54329/switch_test` 指向的本地一次性数据库。
- 不登录 Docker Hub、不推送镜像、不创建 Git 标签、不更新 `latest`，也不连接 NAS 或 Cloudflare 生产资源。
- 每次创建本地 Git 提交前先向用户说明精确范围并取得明确确认；确认后在同一操作中完成 `git commit` 与 `git push`。

---

## File Structure

- Modify: `test/postgres-auth-write.test.ts`
  - 增加成功登录删除状态与并发错误登录之间的确定性事务回归测试。
  - 增加只协调真实 `SqlExecutor` 查询到达顺序的测试数据库包装器。
- Modify: `src/repositories/postgres/auth-repository.ts`
  - 用单条原子 upsert 锁定并返回 `login_attempts` 状态。
  - 更新受影响的中文注释，使其准确描述 `ON CONFLICT DO UPDATE ... RETURNING` 行为。
- Modify: `docs/superpowers/specs/2026-07-30-postgres-login-attempt-upsert-race-design.md`
  - 记录已确认的竞态根因、原子 upsert 方案和确定性 RED/GREEN 测试边界，作为本认证修复的设计交付物。
- Create: `docs/superpowers/plans/2026-07-30-postgres-login-attempt-upsert-race.md`
  - 保存本测试先行实施和验证顺序。
- Modify in the Task 10 delivery only: `docs/README.md`
  - 把新设计规格的状态由“待测试先行实施”更新为已实施。
- Modify in the Task 10 delivery only: `docs/quality/quality-and-acceptance.md`
  - 记录确定性 RED/GREEN 证据和最终完整门禁结果。

---

### Task 1: Add the Deterministic Race Regression and Atomic Upsert

**Files:**
- Modify: `test/postgres-auth-write.test.ts:275-352,397-560`
- Modify: `src/repositories/postgres/auth-repository.ts:105-189`
- Modify: `docs/superpowers/specs/2026-07-30-postgres-login-attempt-upsert-race-design.md`
- Create: `docs/superpowers/plans/2026-07-30-postgres-login-attempt-upsert-race.md`

**Interfaces:**
- Consumes: `AppDatabase.transaction<T>()`、`SqlExecutor.query<Row>()`、`AuthService.login(password, now)`、`PostgresAuthRepository.performLoginAttempt()`、现有 `createDeferred()` 与 `withinTestStage()`。
- Produces: 测试辅助器 `coordinateLoginAttemptDeletionRace(database, events): AppDatabase`；仓储公开接口和 `AtomicLoginAttemptResult` 类型均不改变。

- [ ] **Step 1: Write the failing real-PostgreSQL race test**

在现有“六个同快照并发登录”用例之后加入下列用例。它先用一次已完成的错误登录建立已提交状态，再让合法登录持有真实行锁并停在删除前；第二个错误登录把旧 `SELECT FOR UPDATE` 或新原子 upsert 提交给真实执行器后，才释放合法登录提交：

```ts
  it("成功登录删除失败状态时并发错误登录仍原子取得新的失败窗口", async () => {
    /**
     * 先提交一次错误登录以建立既有 login_attempts，再让合法登录锁定该行并暂停于真实 DELETE 之前。
     * 第二个错误登录把旧 SELECT FOR UPDATE 或新原子 upsert 先提交给 PostgreSQL，随后才释放合法登录；
     * 旧路径会在删除提交后观察到缺行，原子 upsert 则必须取得新的失败窗口。协调器不读取任何参数。
     */
    await initialize(createAuth(database), "2026-07-27T00:00:00.000Z");
    await expect(
      createAuth(database).login(
        "synthetic-preexisting-wrong-password",
        "2026-07-27T00:00:30.000Z",
      ),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    const successfulLoginReachedDelete = createDeferred<void>();
    const invalidLoginSubmittedLockingQuery = createDeferred<void>();
    const releaseSuccessfulLoginDelete = createDeferred<void>();
    const coordinatedDatabase = coordinateLoginAttemptDeletionRace(database, {
      onSuccessfulLoginReachedDelete: successfulLoginReachedDelete.resolve,
      onInvalidLoginSubmittedLockingQuery:
        invalidLoginSubmittedLockingQuery.resolve,
      releaseSuccessfulLoginDelete: releaseSuccessfulLoginDelete.promise,
    });
    const auth = createAuth(coordinatedDatabase);
    let successfulLogin: Promise<unknown> | undefined;
    let invalidLogin: Promise<unknown> | undefined;

    try {
      successfulLogin = auth.login(
        syntheticPassword,
        "2026-07-27T00:01:00.000Z",
      );
      await withinTestStage(
        successfulLoginReachedDelete.promise,
        "合法登录未到达失败状态删除边界",
      );

      invalidLogin = auth.login(
        "synthetic-delete-race-wrong-password",
        "2026-07-27T00:01:01.000Z",
      );
      await withinTestStage(
        invalidLoginSubmittedLockingQuery.promise,
        "并发错误登录未提交失败状态锁定语句",
      );

      releaseSuccessfulLoginDelete.resolve();
      await expect(successfulLogin).resolves.toMatchObject({
        token: expect.any(String),
      });
      await expect(invalidLogin).rejects.toBeInstanceOf(
        InvalidCredentialsError,
      );

      const stored = await database.query<{
        failedCount: number;
        lockedUntil: Date | null;
      }>(
        `SELECT failed_count AS "failedCount",
                locked_until AS "lockedUntil"
           FROM login_attempts
          WHERE id = 1`,
      );
      expect(stored.rows).toEqual([
        { failedCount: 1, lockedUntil: null },
      ]);
      await expect(countActiveSessions(database)).resolves.toBe(1);
    } finally {
      // 任何 RED 断言或阶段诊断失败都释放真实事务，避免 pool.end 被占用连接无限阻塞。
      releaseSuccessfulLoginDelete.resolve();
      await Promise.allSettled(
        [successfulLogin, invalidLogin].filter(
          (operation): operation is Promise<unknown> =>
            operation !== undefined,
        ),
      );
    }
  }, 10_000);
```

- [ ] **Step 2: Add the deterministic transaction coordinator**

在 `withinTestStage()` 后加入下列辅助器。事务序号只在包装器内部区分本用例主动按顺序启动的合法登录与错误登录；第二个事务只有在把旧独立锁定查询或新原子 upsert 交给真实执行器后才发信号，所有锁、提交和回滚仍交给真实数据库：

```ts
/**
 * 仅协调本用例按顺序启动的两个登录事务：第一个在真实失败状态 DELETE 前暂停；
 * 第二个把旧 SELECT FOR UPDATE 或新原子 upsert 交给真实 SqlExecutor 后才发出到达信号。
 * 包装器不检查 parameters，因而不收集密码派生值或会话摘要；事务语义仍完全使用生产 AppDatabase。
 */
function coordinateLoginAttemptDeletionRace(
  database: AppDatabase,
  events: {
    onSuccessfulLoginReachedDelete: () => void;
    onInvalidLoginSubmittedLockingQuery: () => void;
    releaseSuccessfulLoginDelete: Promise<void>;
  },
): AppDatabase {
  let transactionOrder = 0;
  return {
    query: (sql, parameters) => database.query(sql, parameters),
    transaction: (work) => {
      const currentOrder = transactionOrder;
      transactionOrder += 1;
      return database.transaction(async (transaction) => {
        const coordinatedExecutor: SqlExecutor = {
          async query<Row>(
            sql: string,
            parameters?: readonly unknown[],
          ) {
            if (
              currentOrder === 0 &&
              /DELETE\s+FROM\s+login_attempts/i.test(sql)
            ) {
              events.onSuccessfulLoginReachedDelete();
              await events.releaseSuccessfulLoginDelete;
            }
            const isOldLockingSelect =
              /SELECT[\s\S]+FROM\s+login_attempts[\s\S]+FOR\s+UPDATE/i.test(
                sql,
              );
            const isAtomicLockingUpsert =
              /INSERT\s+INTO\s+login_attempts[\s\S]+ON\s+CONFLICT[\s\S]+DO\s+UPDATE[\s\S]+RETURNING/i.test(
                sql,
              );
            if (
              currentOrder === 1 &&
              (isOldLockingSelect || isAtomicLockingUpsert)
            ) {
              // 先调用真实 executor，再发信号，保证控制协程释放 DELETE 时锁定语句已进入 PostgreSQL。
              const pendingQuery = transaction.query<Row>(
                sql,
                parameters,
              );
              events.onInvalidLoginSubmittedLockingQuery();
              return pendingQuery;
            }
            return transaction.query<Row>(sql, parameters);
          },
        };
        return work(coordinatedExecutor);
      });
    },
    withAdvisoryLock: (key, work) =>
      database.withAdvisoryLock(key, work),
    close: () => Promise.resolve(),
  };
}
```

- [ ] **Step 3: Start and verify the disposable PostgreSQL service**

Run:

```bash
docker compose -f docker-compose.dev.yml up -d postgres
docker compose -f docker-compose.dev.yml ps postgres
```

Expected: `postgres` is healthy and only its development port `127.0.0.1:54329` is available to the host.

- [ ] **Step 4: Run the new test and verify RED**

Run:

```bash
TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test \
  npx vitest run test/postgres-auth-write.test.ts \
  -t "成功登录删除失败状态时并发错误登录仍原子取得新的失败窗口"
```

Expected: FAIL because the second login rejects with the current internal error `登录资格锁定未返回状态`, not `InvalidCredentialsError`. The pre-existing-row precondition must make this deterministic; the `finally` block must still release both transactions and let Vitest exit normally.

- [ ] **Step 5: Replace the two-statement status acquisition with the minimal atomic upsert**

在 `PostgresAuthRepository.performLoginAttempt()` 中删除单独的 `INSERT ... DO NOTHING` 和 `SELECT ... FOR UPDATE`，改为：

```ts
      /**
       * 单条 upsert 同时确保单例状态存在、取得冲突行排他锁并返回当前值。合法登录可能在等待事务提交前
       * 删除该行；DO UPDATE/INSERT 的 PostgreSQL 冲突重试与同语句 RETURNING 可避免随后 SELECT 观察到缺行。
       * 自赋值只保留串行化后的失败次数和锁定截止时间，表中没有更新时间触发器，不改变业务状态。
       */
      const attemptResult = await transaction.query<LoginAttemptRow>(
        `INSERT INTO login_attempts (id, failed_count, locked_until)
         VALUES (1, 0, NULL)
         ON CONFLICT (id) DO UPDATE
           SET failed_count = login_attempts.failed_count,
               locked_until = login_attempts.locked_until
         RETURNING failed_count AS "failedCount",
                   locked_until AS "lockedUntil"`,
      );
      const attempt = attemptResult.rows[0];
      // RETURNING 正常必须产生一行；不变量错误保持通用且不得附带 SQL、参数、凭据或驱动详情。
      if (!attempt) throw new Error("登录资格锁定未返回状态");
```

不要修改后续锁定判断、密码校验、失败计数更新、成功删除状态或会话插入逻辑。

- [ ] **Step 6: Run the focused test and verify GREEN**

Run the exact command from Step 4 again.

Expected: PASS; the invalid login rejects with `InvalidCredentialsError`, `login_attempts.failed_count` equals `1`, `locked_until` is `NULL`, and exactly one active successful session remains.

- [ ] **Step 7: Replace the invalid simultaneous-request ordering assumption**

删除原“六个同快照并发登录”用例以及任何 `pg_locks` 轮询、额外观察连接和无效的 `getLoginAttempt` 同步分支。把前一个五错误并发用例收紧为下列确定性业务语义：

```ts
  it("五个并发错误登录形成锁定后在密码验证前拒绝后续正确密码", async () => {
    /**
     * 五个错误请求仍真实并发竞争 PostgreSQL 单例状态，完成后必须串行累计到五次并形成锁定。
     * 正确密码只在锁定已提交后发起，因此本用例验证锁定会在 PBKDF2/密码比较前短路，
     * 不把客户端 Promise 数组顺序误当作 PostgreSQL 对真正并发事务的锁授予承诺。
     */
    await initialize(createAuth(database), "2026-07-27T00:00:00.000Z");
    let passwordVerificationCount = 0;
    const repository = observePasswordVerifications(
      new PostgresAuthRepository(database),
      () => {
        passwordVerificationCount += 1;
      },
    );
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        new AuthService(repository).login(
          "synthetic-concurrent-wrong-password",
          "2026-07-27T00:01:00.000Z",
        )),
    );

    expect(attempts).toSatisfy(
      (results: PromiseSettledResult<unknown>[]) =>
        results.every(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof InvalidCredentialsError,
        ),
    );
    expect(passwordVerificationCount).toBe(5);
    await expect(
      new AuthService(repository).login(
        syntheticPassword,
        "2026-07-27T00:15:59.999Z",
      ),
    ).rejects.toBeInstanceOf(LoginLockedError);
    // 活跃锁定请求不得进入密码校验；计数必须保持为前五个错误请求对应的五次。
    expect(passwordVerificationCount).toBe(5);
    await expect(countActiveSessions(database)).resolves.toBe(0);

    const stored = await database.query<{
      failedCount: number;
      lockedUntil: Date;
    }>(
      `SELECT failed_count AS "failedCount",
              locked_until AS "lockedUntil"
         FROM login_attempts
        WHERE id = 1`,
    );
    expect(stored.rows[0]?.failedCount).toBe(5);
    expect(stored.rows[0]?.lockedUntil.toISOString()).toBe(
      "2026-07-27T00:16:00.000Z",
    );
  });
```

用下列只包装真实仓储密码校验回调的辅助器替换旧同步辅助器：

```ts
/**
 * 只统计真实原子登录端口实际进入密码校验的次数；不读取凭据内容，也不改变数据库事务、锁或返回值。
 * 调用方用它证明活跃锁定会在 PBKDF2 前短路，而不是尝试规定真正并发事务的数据库锁授予顺序。
 */
function observePasswordVerifications(
  repository: AuthRepository,
  onPasswordVerification: () => void,
): AuthRepository {
  return new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "performLoginAttempt") {
        return (
          input: Parameters<AuthRepository["performLoginAttempt"]>[0],
          verifyPassword: Parameters<AuthRepository["performLoginAttempt"]>[1],
        ) =>
          target.performLoginAttempt(input, async (credential) => {
            onPasswordVerification();
            return verifyPassword(credential);
          });
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
```

- [ ] **Step 8: Run focused authentication regressions repeatedly**

Run:

```bash
for run in {1..20}; do
  TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test \
    npx vitest run test/postgres-auth-write.test.ts \
    -t "成功登录删除失败状态时并发错误登录仍原子取得新的失败窗口|五个并发错误登录形成锁定后在密码验证前拒绝后续正确密码" \
    || exit 1
done

TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test \
  npx vitest run test/postgres-auth-write.test.ts test/postgres-migrations.test.ts
npx tsc --noEmit
git diff --check
```

Expected: 20 次竞态/阈值组合全部通过；完整 PostgreSQL 认证与迁移测试、类型检查和空白检查退出码均为 `0`。

- [ ] **Step 9: Check comment and scope consistency**

逐项核对：

```bash
git diff -- src/repositories/postgres/auth-repository.ts \
  test/postgres-auth-write.test.ts \
  docs/superpowers/specs/2026-07-30-postgres-login-attempt-upsert-race-design.md \
  docs/superpowers/plans/2026-07-30-postgres-login-attempt-upsert-race.md
git status --short
```

Expected:

- 源码注释准确说明 upsert、自赋值、锁和 `RETURNING` 的原因。
- 测试注释准确说明真实 PostgreSQL 与测试协调器的边界。
- 没有迁移、D1、API、会话格式或运行配置被本认证修复修改。
- 既有 Task 10 文件仍保持为独立未提交改动。

- [ ] **Step 10: Request auth-fix commit confirmation, then commit and push**

向用户报告 RED 证据、20 次稳定回归和精确文件范围。取得新的明确确认后，在同一操作中只提交认证修复和本计划：

```bash
git add src/repositories/postgres/auth-repository.ts \
  test/postgres-auth-write.test.ts \
  docs/superpowers/specs/2026-07-30-postgres-login-attempt-upsert-race-design.md \
  docs/superpowers/plans/2026-07-30-postgres-login-attempt-upsert-race.md
git commit -m "fix: 原子锁定登录失败状态"
git push origin codex/nas-docker-postgresql
```

不得把 `Dockerfile`、`.github/`、`package.json`、`package-lock.json`、`test/github-actions-release.test.mjs`、`docs/README.md` 或 `docs/quality/quality-and-acceptance.md` 混入该提交。

---

### Task 2: Re-run the Task 10 Gate and Finalize Its Separate Delivery

**Files:**
- Modify: `docs/superpowers/plans/2026-07-30-postgres-login-attempt-upsert-race.md`
- Modify: `docs/superpowers/plans/2026-07-27-nas-docker-postgresql-migration.md`
- Modify: `docs/README.md`
- Modify: `docs/quality/quality-and-acceptance.md`
- Modify: `.github/workflows/release-image.yml`
- Modify: `test/github-actions-release.test.mjs`
- Preserve and verify existing Task 10 changes:
  - `Dockerfile`
  - `package.json`
  - `package-lock.json`
  - `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Task 1 的已推送原子 upsert 修复、现有 Docker/Compose 合同、GitHub Actions 合同和本地 M1 Docker Desktop。
- Produces: 可由普通分支/PR 验证、仅由严格 `vX.Y.Z` 标签发布的多架构 Docker Hub 工作流；不执行真实发布。

- [ ] **Step 1: Update the documentation status after verified implementation**

把 `docs/README.md` 中新设计规格状态改为：

```markdown
| [PostgreSQL 登录失败状态并发竞态修复设计规格](superpowers/specs/2026-07-30-postgres-login-attempt-upsert-race-design.md) | 用单条原子 upsert 消除成功登录删除状态与并发登录锁定读取之间的缺行窗口 | 已实施并通过确定性 PostgreSQL 回归 |
```

在 `docs/quality/quality-and-acceptance.md` 的 Task 10 验收之后增加：

```markdown
### 3.20 PostgreSQL 登录失败状态并发竞态回归（2026-07-30）

- Task 10 提交前完整门禁曾在 435 项测试中的并发登录用例暴露“登录资格锁定未返回状态”；隔离重复运行再次复现，确认是成功登录删除 `login_attempts` 与等待事务执行 `DO NOTHING` 后再读取之间的真实竞态，而非断言噪声。
- 新增真实 PostgreSQL 确定性事务协调测试，在旧两语句实现下稳定得到预期 RED；改用单条 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` 后，错误登录稳定返回无效凭据并进入新的第一次失败窗口，合法登录会话仍原子提交且只保存摘要。
- 缺行竞态与“并发五次错误后正确密码锁定”组合连续 20 次通过；完整认证、迁移、项目测试、DOM、Chromium、类型、构建、Docker/工作流合同、中文注释、空白和双架构构建门禁均通过。过程未读取或输出真实密码、哈希、盐、恢复码、Cookie、数据库凭据或 Docker Hub Secrets，也未推送镜像、创建标签或修改 NAS/Cloudflare 资源。
```

最终测试数量必须用本轮命令的真实输出替换上一段第三条中的概述；不得猜测或沿用失败前计数。

- [ ] **Step 2: Run the complete local quality gate**

Run:

```bash
TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test \
  npx vitest run
npm run test:dom -- --run
npx vitest run test/playwright-browser-launcher.test.ts
npx tsc --noEmit
npm run build
npm run test:docker-config
npm run test:github-actions
npm run test:workflow-comments
actionlint .github/workflows/ci.yml .github/workflows/release-image.yml
git diff --check
```

Expected: 新增竞态测试包含在完整测试内且全部通过；DOM 为 16 项、Chromium smoke 为 4 项、Docker 合同为 14 项、工作流合同为 9 项，其他命令均退出 `0`。

- [ ] **Step 3: Re-run the real M1 multi-architecture Docker build without publishing**

Run:

```bash
docker buildx build \
  --platform linux/arm64,linux/amd64 \
  --output type=cacheonly \
  .
```

Expected: 两个平台均完成固定 Node 基础、`npm ci`、生产构建、精确 Playwright Chromium 和非 root 运行层；命令不包含 `--push`，不登录 Docker Hub，也不创建 manifest/tag。

- [ ] **Step 4: Review secrets, comments, and exact Task 10 scope**

Run:

```bash
git status --short
git diff -- Dockerfile package.json package-lock.json \
  .github/workflows/ci.yml .github/workflows/release-image.yml \
  test/github-actions-release.test.mjs \
  docs/README.md docs/quality/quality-and-acceptance.md \
  docs/superpowers/plans/2026-07-27-nas-docker-postgresql-migration.md \
  docs/superpowers/plans/2026-07-30-postgres-login-attempt-upsert-race.md
```

人工确认：

- 普通 CI 没有 Docker Hub 登录、Secrets、push 或 `latest`。
- 标签发布在登录前严格校验 `vX.Y.Z`，只引用 `DOCKERHUB_USERNAME` 与 `DOCKERHUB_TOKEN`。
- 工作流、Dockerfile 和测试的新增/修改注释均为中文且与行为一致。
- 没有真实 Docker Hub 用户名、token、NAS 数据库密码、Cookie、恢复码或 Telegram 凭据。
- 本轮没有执行 `docker login`、`docker push`、`git tag` 或任何 NAS/Cloudflare 外部写入。

- [ ] **Step 5: Request Task 10 commit confirmation, then commit and push**

向用户报告完整测试数量、各专项门禁和双架构构建结果，并说明首次真实标签发布仍未执行。取得新的明确确认后，在同一操作中提交和推送 Task 10：

```bash
git add Dockerfile package.json package-lock.json \
  .github/workflows/ci.yml .github/workflows/release-image.yml \
  test/github-actions-release.test.mjs \
  docs/README.md docs/quality/quality-and-acceptance.md \
  docs/superpowers/plans/2026-07-27-nas-docker-postgresql-migration.md \
  docs/superpowers/plans/2026-07-30-postgres-login-attempt-upsert-race.md
git commit -m "ci: 发布多架构 Docker 镜像"
git push origin codex/nas-docker-postgresql
```

不要创建或推送 `vX.Y.Z` 标签；Docker Hub 首次公开发布必须由用户另行确认精确版本。
