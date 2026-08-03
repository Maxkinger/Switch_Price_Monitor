# NAS Docker and PostgreSQL Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Cloudflare production runtime with a locally debuggable Node.js, PostgreSQL, Playwright, and Docker Compose stack that publishes multi-architecture images to Docker Hub and preserves every existing business feature.

**Architecture:** Keep React and the platform-neutral route/service/provider layers, move them out of the Worker namespace, and replace D1, Worker fetch/scheduled handlers, Static Assets, Cron Trigger, and Browser Binding behind focused Node/PostgreSQL/Playwright adapters. Run one Node application container and one private PostgreSQL container; use PostgreSQL transactions and advisory locks for write atomicity, migrations, and scheduler exclusivity.

**Tech Stack:** Node.js 22, TypeScript 5.8+, React 19, Vite 7, Vitest 4, Hono Node adapter, `pg`, PostgreSQL 17, Playwright Chromium, Docker Compose, Docker Buildx, GitHub Actions, Docker Hub.

## Global Constraints

- The only target production host is Synology DS423+ on `linux/amd64`; the local Apple Silicon M1 development path runs `linux/arm64`.
- The final repository must not retain a production dependency on Cloudflare Worker, D1, Wrangler, Cron Trigger, Static Assets Binding, Secrets, or Browser Binding.
- The migration starts with a fresh PostgreSQL database and does not import D1 data.
- The application remains single-admin and preserves initialization, password login, recovery code, login lockout, session revocation, subscriptions, five-region collection, history, settings, export, Telegram, retention, manual refresh, and Japanese upgrade-pack discovery.
- The first deployment target is LAN HTTP. Cookies always use `HttpOnly` and `SameSite=Strict`; `COOKIE_SECURE=false` is explicit for LAN HTTP and must be configurable to `true` for future HTTPS.
- PostgreSQL and Chromium debugging ports are never exposed to the NAS host or LAN.
- PostgreSQL timestamps use `TIMESTAMPTZ`, booleans use `BOOLEAN`, structured settings use `JSONB`, and monetary values remain integer minor units.
- All former D1 batch boundaries become explicit PostgreSQL transactions. Database migration and scheduled work use distinct PostgreSQL advisory locks.
- Playwright launches at most one browser for a relation batch, processes no more than three items serially in isolated contexts, keeps the thirty-second item timeout, and never retries automatically.
- The Docker Hub repository is public. GitHub Actions publishes both `linux/arm64` and `linux/amd64`; NAS Compose pins an exact application version.
- No secret, password, recovery code, session token, real Telegram credential, Docker Hub token, or database password may enter source control, image layers, tests, screenshots, or ordinary logs.
- Every added or modified source, test, SQL, Docker, GitHub Actions, build, and runtime configuration file must contain detailed Chinese comments explaining responsibility, data constraints, boundary conditions, and security or business reasons.
- Feature work follows RED → GREEN → focused regression → full relevant gate. Refactors first capture a passing baseline and must not change behavior.
- Before every local commit, report the exact scope and obtain explicit user confirmation. After confirmation, create the commit and `git push` in the same operation; never leave a local-only commit.
- Preserve unrelated working-tree changes. At execution start use `superpowers:using-git-worktrees` to create an isolated `codex/` worktree unless the user explicitly chooses another safe branch arrangement.

---

## Planned File Structure

```text
src/
  app/                                      # Existing React application
  shared/                                   # Existing shared domain and display rules
  routes/                                   # Platform-neutral API route handlers
  services/                                 # Business and scheduler services
  providers/                                # Nintendo, exchange-rate, Telegram providers
    playwright/
      japanese-upgrade-browser.ts           # Local Chromium adapter
  repositories/
    ports.ts                                # Narrow repository/database-facing contracts
    postgres/                               # PostgreSQL implementations
  server/
    app.ts                                  # Hono/Fetch request composition
    config.ts                               # Validated runtime configuration
    dependencies.ts                         # Request and scheduler dependency composition
    index.ts                                # Process entry and shutdown
    scheduler.ts                            # Cron lifecycle and advisory-lock wrapper
    database/
      pool.ts                               # pg pool and transaction implementation
      migrations.ts                         # Immutable migration runner
      types.ts                              # SQL executor and transaction types
migrations/postgres/
  0001_initial.sql                          # Complete fresh PostgreSQL schema
test/support/
  postgres.ts                               # Test database reset/migration helper
  server-env.ts                             # Safe runtime configuration fixture
scripts/
  backup-postgres.sh                        # Atomic pg_dump backup
  restore-postgres.sh                       # Empty-target pg_restore
.github/workflows/
  ci.yml                                    # PR/push quality gate
  release-image.yml                         # Tagged multi-arch Docker Hub release
Dockerfile
docker-compose.dev.yml
docker-compose.prod.yml
.dockerignore
.env.example
```

The final implementation may keep a smaller existing file in place when moving it would only create churn, but it must not leave platform-neutral code under `src/worker/` after Task 11.

---

### Task 1: Establish Platform-Neutral Source Boundaries

**Files:**
- Move: `src/worker/routes/*.ts` → `src/routes/*.ts`
- Move: `src/worker/services/*.ts` → `src/services/*.ts`
- Move: `src/worker/repositories/*.ts` → temporary `src/repositories/*.ts`
- Move: platform-neutral `src/worker/providers/*.ts` → `src/providers/*.ts`
- Keep temporarily: `src/worker/index.ts`
- Keep temporarily: `src/worker/providers/japanese-upgrade-browser.ts`
- Modify: `test/**/*.test.ts`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: Existing route, service, repository, and provider exports without behavioral changes.
- Produces: Stable platform-neutral import roots under `src/routes`, `src/services`, `src/repositories`, and `src/providers` for later Node/PostgreSQL adapters.

- [ ] **Step 1: Record the pre-refactor quality baseline**

Run:

```bash
npm test -- --run
npm run test:dom -- --run
npx tsc --noEmit
npm run build
```

Expected: all current Worker, D1, DOM, type, and production build gates pass before any move. Record exact file/test counts in the task notes.

- [ ] **Step 2: Move one responsibility group at a time**

Use `git mv` for routes, services, repositories, and all providers except the Cloudflare Playwright adapter. Update relative imports after each group. Do not rename exported classes, functions, request DTOs, or error types.

Example required import change:

```ts
// 业务路由已经与 Worker 生命周期无关；统一从平台中立目录导入，便于 Node 与测试复用同一实现。
import { handleAuthRoute } from "../routes/auth-routes";
```

- [ ] **Step 3: Update tests to the new import roots**

Only change module paths. Assertions, fixtures, test names, D1 setup, and behavior must remain identical in this task.

- [ ] **Step 4: Run the baseline after the move**

Run the four commands from Step 1.

Expected: the same test counts and all exits are zero. Any changed assertion or fixture is a task failure.

- [ ] **Step 5: Check comments and diff scope**

Run:

```bash
git diff --check
rg -n 'src/worker/(routes|services|repositories)' src test
```

Expected: no whitespace errors and no stale imports for moved platform-neutral modules.

- [ ] **Step 6: Request commit confirmation, then commit and push**

Report the exact moved paths and verification counts. After explicit confirmation:

```bash
git add src test tsconfig.json
git commit -m "refactor: separate backend modules from worker runtime"
git push
```

---

### Task 2: Add PostgreSQL Schema, Pool, Transactions, and Migration Runner

**Files:**
- Create: `src/server/database/types.ts`
- Create: `src/server/database/pool.ts`
- Create: `src/server/database/migrations.ts`
- Create: `migrations/postgres/0001_initial.sql`
- Create: `test/support/postgres.ts`
- Create: `test/postgres-database.test.ts`
- Create: `test/postgres-migrations.test.ts`
- Create: `docker-compose.dev.yml`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vitest.config.mts`

**Interfaces:**
- Consumes: Existing tables and constraints from `migrations/0001_core.sql` through `migrations/0006_immediate_manual_refresh.sql`.
- Produces:

```ts
export interface SqlResult<Row> {
  rows: Row[];
  rowCount: number;
}

export interface SqlExecutor {
  query<Row>(sql: string, parameters?: readonly unknown[]): Promise<SqlResult<Row>>;
}

export interface AppDatabase extends SqlExecutor {
  transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T>;
  withAdvisoryLock<T>(key: bigint, work: (connection: SqlExecutor) => Promise<T>): Promise<T | undefined>;
  close(): Promise<void>;
}

export function createPostgresDatabase(connectionString: string): AppDatabase;
export function runMigrations(database: AppDatabase, directory: string): Promise<void>;
```

- [ ] **Step 1: Start the isolated development PostgreSQL**

Create `docker-compose.dev.yml` with a PostgreSQL 17 service, a health check, no production credentials, and a localhost-only development port. Chinese comments must state that the port exists only for local tests and must not be copied to production.

Run:

```bash
docker compose -f docker-compose.dev.yml up -d postgres
docker compose -f docker-compose.dev.yml ps
```

Expected: PostgreSQL reports healthy.

- [ ] **Step 2: Write failing pool and transaction tests**

Add tests proving:

```ts
it("rolls back every statement when transaction work throws", async () => {
  await expect(database.transaction(async (transaction) => {
    await transaction.query("INSERT INTO migration_probe (value) VALUES ($1)", ["kept-only-on-commit"]);
    throw new Error("expected rollback");
  })).rejects.toThrow("expected rollback");

  const result = await database.query<{ count: string }>("SELECT COUNT(*) AS count FROM migration_probe");
  expect(result.rows[0].count).toBe("0");
});
```

The test setup first creates `migration_probe` inside the disposable test database and truncates it before each case; it never writes the development or NAS database. Also cover commit, parameter binding, pool close, advisory-lock acquired, and advisory-lock contention returning `undefined`.

- [ ] **Step 3: Run the database tests to verify RED**

Run:

```bash
TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test \
  npx vitest run test/postgres-database.test.ts
```

Expected: FAIL because `createPostgresDatabase` and the contracts do not exist.

- [ ] **Step 4: Implement the pool and explicit transaction boundary**

Use one checked-out `pg.PoolClient` for each transaction and advisory lock. Always release it in `finally`. Convert `pg` row counts into a non-null integer and never expose the raw client outside `SqlExecutor`.

Core implementation shape:

```ts
export async function transaction<T>(work: (executor: SqlExecutor) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await work(createExecutor(client));
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 5: Write the failing migration and schema tests**

Cover:

- all expected tables and indexes exist;
- booleans are `BOOLEAN`;
- timestamps are `TIMESTAMPTZ`;
- settings JSON is `JSONB`;
- prices remain integer minor units;
- every required foreign key and unique constraint rejects invalid data;
- applying `0001_initial.sql` twice is safe through the migration table;
- modifying an already applied migration checksum stops startup;
- concurrent runners serialize through the migration advisory lock.

- [ ] **Step 6: Implement `0001_initial.sql` and migration checksums**

The SQL must be a complete fresh schema, not a literal SQLite translation. Include Chinese SQL comments for authentication, price provenance, notification deduplication, retention, and destructive deletion rules.

Store at least:

```sql
CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

Read migration files in lexical order, hash exact bytes with SHA-256, compare existing checksums, and execute each new file in one transaction while holding the migration lock.

- [ ] **Step 7: Run focused and regression tests**

Run:

```bash
TEST_DATABASE_URL=postgres://switch_test:switch_test@127.0.0.1:54329/switch_test \
  npx vitest run test/postgres-database.test.ts test/postgres-migrations.test.ts
npx tsc --noEmit
git diff --check
```

Expected: all focused tests pass; type and whitespace checks exit zero.

- [ ] **Step 8: Request commit confirmation, then commit and push**

After reporting schema constraints, test counts, and the development-only port:

```bash
git add package.json package-lock.json vitest.config.mts docker-compose.dev.yml \
  migrations/postgres src/server/database test/support/postgres.ts \
  test/postgres-database.test.ts test/postgres-migrations.test.ts
git commit -m "feat: add postgres database foundation"
git push
```

---

### Task 3: Migrate Read Repositories and Query Services to PostgreSQL

**Files:**
- Create: `src/repositories/ports.ts`
- Create: `src/repositories/postgres/settings-repository.ts`
- Create: `src/repositories/postgres/collection-repository.ts`
- Create: `src/repositories/postgres/price-repository.ts`
- Create: `src/repositories/postgres/exchange-rate-repository.ts`
- Create: `src/repositories/postgres/retention-repository.ts`
- Create: `src/repositories/postgres/subscription-repository.ts`
- Create: `src/repositories/postgres/subscription-detail-repository.ts`
- Create: `src/repositories/postgres/product-health-repository.ts`
- Create: `src/repositories/postgres/notification-event-repository.ts`
- Create: `src/repositories/postgres/dashboard-repository.ts`
- Create: `src/repositories/postgres/history-repository.ts`
- Create: `src/repositories/postgres/export-repository.ts`
- Create: `src/repositories/d1/dashboard-repository.ts`
- Create: `src/repositories/d1/history-repository.ts`
- Create: `src/repositories/d1/export-repository.ts`
- Modify: `src/services/dashboard-service.ts`
- Modify: `src/services/history-service.ts`
- Modify: `src/services/export-service.ts`
- Modify: database-backed tests for the files above

**Interfaces:**
- Consumes: `SqlExecutor` and `AppDatabase` from Task 2.
- Produces: PostgreSQL repositories with the same public business methods and DTO results currently consumed by services and routes.
- Direct-query responsibilities: dedicated PostgreSQL dashboard, history and export repositories own their read SQL; the corresponding services depend only on narrow ports and retain platform-neutral DTOs.
- Worker transition boundary: dedicated D1 dashboard, history and export adapters preserve existing Worker route constructors and production behavior while Node/PostgreSQL runtime composition is deferred; they are temporary compatibility code, not a second query-service design.

- [ ] **Step 1: Define narrow repository ports**

Do not expose `pg`, SQL strings, or database rows to services. Define only methods used by consumers. Example:

```ts
export interface SettingsReader {
  get(): Promise<AppSettings | null>;
}

export interface DashboardReader {
  getOverview(now: string): Promise<DashboardOverview>;
}
```

`AppSettings` and `DashboardOverview` are the existing platform-neutral service DTOs. Reuse them rather than creating PostgreSQL-specific DTOs.

- [ ] **Step 2: Convert one repository test to PostgreSQL and verify RED**

Start with settings. Replace `cloudflare:test` and `env.DB` setup with `createTestDatabase()` from Task 2. Keep all existing assertions and add a JSONB round-trip assertion.

Run:

```bash
npx vitest run test/settings-and-subscriptions.test.ts
```

Expected: FAIL because the PostgreSQL settings repository is not implemented.

- [ ] **Step 3: Implement settings with `$1` parameters and typed rows**

Example:

```ts
interface SettingsRow {
  enabledRegions: unknown;
  defaultSearchRegion: string;
}

const result = await this.database.query<SettingsRow>(
  `SELECT enabled_regions_json AS "enabledRegions",
          default_search_region AS "defaultSearchRegion"
     FROM settings
    WHERE id = 1`,
);
```

PostgreSQL aliases must match TypeScript row fields. Validate JSONB values through the existing service rules before returning application settings.

- [ ] **Step 4: Repeat RED/GREEN per read repository**

Convert in this order:

1. exchange rate and retention;
2. collection and price;
3. subscription list and detail;
4. product health and notification events;
5. dashboard, history, and export direct-query services, each extracted into its dedicated PostgreSQL read repository while temporary D1 adapters keep the existing Worker routes stable.

For every repository, first run its current test against PostgreSQL and record the expected failure, then implement only the required SQL and rerun.

- [ ] **Step 5: Add PostgreSQL-specific regression assertions**

Cover:

- latest snapshot and historical minimum ordering with equal timestamps;
- `BIGINT` count conversion without unsafe implicit casts;
- nullable left joins;
- `BOOLEAN` mapping;
- JSONB settings validation;
- retention cutoff equality;
- notification dedupe uniqueness;
- CSV queries never include authentication or Telegram columns.

- [ ] **Step 6: Run the read-path gate**

Run all converted repository/service tests plus:

```bash
npx tsc --noEmit
git diff --check
rg -n 'D1Database|\\.prepare\\(|\\.batch\\(' src/repositories src/services/dashboard-service.ts \
  src/services/history-service.ts src/services/export-service.ts
```

Expected: tests pass and the scan finds no D1 calls in migrated paths.

- [ ] **Step 7: Request commit confirmation, then commit and push**

After explicit approval:

```bash
git add src/repositories src/services test
git commit -m "feat: migrate read repositories to postgres"
git push
```

---

### Task 4: Migrate Authentication and Transactional Subscription Writes

**Files:**
- Create: `src/repositories/postgres/auth-repository.ts`
- Create: `src/repositories/postgres/manual-refresh-repository.ts`
- Create: `src/repositories/postgres/subscription-confirmation-repository.ts`
- Modify: `src/services/auth-service.ts`
- Modify: `src/services/subscription-service.ts`
- Modify: `src/services/subscription-confirmation-service.ts`
- Modify: `src/services/subscription-region-completion-service.ts`
- Modify: `src/routes/auth-guard.ts`
- Modify: `src/routes/*.ts`
- Modify: authentication, subscription, deletion, confirmation, completion, and refresh tests

**Interfaces:**
- Consumes: `AppDatabase.transaction()` and PostgreSQL repositories from Tasks 2–3.
- Produces:

```ts
export interface HashedAdminSetup {
  passwordHash: string;
  passwordSalt: string;
  recoveryHash: string;
  recoverySalt: string;
  createdAt: string;
  initialSettings: Omit<InitialSettings, "createdAt">;
}

export interface StoredSession {
  id: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
}

export interface LoginAttemptRecord {
  failedCount: number;
  lockedUntil: string | null;
}

export interface PasswordCredential {
  passwordHash: string;
  passwordSalt: string;
}

export interface RecoveryCredential {
  recoveryHash: string;
  recoverySalt: string;
  recoveryUsedAt: string | null;
}

export interface PasswordResetWrite {
  passwordHash: string;
  passwordSalt: string;
  recoveryUsedAt: string;
  sessionRevokedAt: string;
}

export interface AuthRepository {
  isInitialized(): Promise<boolean>;
  initialize(input: HashedAdminSetup): Promise<void>;
  getLoginAttempt(): Promise<LoginAttemptRecord | null>;
  getPasswordCredential(): Promise<PasswordCredential | null>;
  createSession(session: StoredSession): Promise<void>;
  getRecoveryCredential(): Promise<RecoveryCredential | null>;
  resetPassword(input: PasswordResetWrite): Promise<void>;
  revokeSession(tokenHash: string, now: string): Promise<void>;
  isSessionValid(tokenHash: string, now: string): Promise<boolean>;
  saveLoginAttempt(input: LoginAttemptRecord): Promise<void>;
  clearLoginAttempt(): Promise<void>;
}
```

`InitialSettings` is the existing domain type. `initialize()` writes administrator credentials and initial settings in one transaction; `resetPassword()` updates the password, consumes recovery state, revokes every session, and clears login attempts in one transaction. All route handlers accept repository/service dependencies rather than `D1Database`.

- [ ] **Step 1: Write failing auth transaction tests**

Prove:

- simultaneous first initialization yields exactly one administrator;
- password reset changes the password hash, consumes recovery state, and revokes every session atomically;
- a forced failure before commit changes none of those rows;
- login lockout increments and clears correctly using PostgreSQL timestamps.

Run the focused auth tests and verify they fail on missing PostgreSQL implementations.

- [ ] **Step 2: Implement the auth repository and preserve Web Crypto behavior**

Keep password derivation parameters, hash formats, Cookie token hashing, lockout thresholds, and safe error messages unchanged. Move SQL into the repository; the service keeps security rules.

- [ ] **Step 3: Write failing batch confirmation and deletion transaction tests**

Inject a deterministic failing statement after at least one valid write and assert zero rows remain in every affected table. Cover:

- new multi-region subscription;
- existing subscription completion;
- batch permanent deletion;
- missing ID rejection before writes;
- duplicate normalized game under concurrency.

- [ ] **Step 4: Implement explicit transaction callbacks**

The repository must accept the transaction executor for every statement:

```ts
await this.database.transaction(async (transaction) => {
  await insertGame(transaction, game);
  await insertRegionalProducts(transaction, products);
  await insertSubscription(transaction, subscription);
  await insertRegions(transaction, regions);
});
```

Do not emulate D1 `batch()` or issue independent pool queries inside a transaction.

- [ ] **Step 5: Replace route database parameters with service dependencies**

Example target:

```ts
export interface AuthRouteDependencies {
  auth: AuthService;
  sessions: SessionReader;
  cookieSecure: boolean;
}

export async function handleAuthRoute(
  request: Request,
  dependencies: AuthRouteDependencies,
): Promise<Response | null>;
```

Add Chinese comments explaining why `cookieSecure` is explicit and never inferred from untrusted forwarding headers.

- [ ] **Step 6: Run authentication and write-path regression**

Run all auth, subscription, confirmation, completion, refresh, deletion, notification, and schema tests. Then run:

```bash
npx tsc --noEmit
git diff --check
rg -n 'D1Database|\\.batch\\(' src/routes src/services src/repositories/postgres
```

Expected: no D1 type or batch call in migrated application paths.

- [ ] **Step 7: Request commit confirmation, then commit and push**

After explicit approval:

```bash
git add src/routes src/services src/repositories/postgres test
git commit -m "feat: migrate auth and subscription writes to postgres"
git push
```

---

### Task 5: Add the Node HTTP Server and Frontend-Only Vite Build

**Files:**
- Create: `src/server/config.ts`
- Create: `src/server/dependencies.ts`
- Create: `src/server/app.ts`
- Create: `src/server/index.ts`
- Create: `test/server-config.test.ts`
- Create: `test/server-http.test.ts`
- Create: `test/server-shutdown.test.ts`
- Modify: `vite.config.ts`
- Create: `tsup.config.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`

**Interfaces:**
- Consumes: Platform-neutral routes and PostgreSQL dependencies from Tasks 3–4.
- Produces:

```ts
export interface ServerConfig {
  port: number;
  databaseUrl: string;
  cookieSecure: boolean;
  staticDirectory: string;
  maximumBodyBytes: number;
  shutdownGraceMs: number;
  telegramBotToken?: string;
  telegramChatId?: string;
}

export interface ServerDependencies {
  dispatchApi(request: Request): Promise<Response | null>;
}

export interface RunningServer {
  close(): Promise<void>;
  finished(): Promise<void>;
}

export function readServerConfig(environment: NodeJS.ProcessEnv): ServerConfig;
export function createServerApp(
  config: Pick<ServerConfig, "staticDirectory" | "maximumBodyBytes">,
  dependencies: ServerDependencies,
): { fetch(request: Request): Promise<Response> };
export async function startServer(
  config: ServerConfig,
  dependencies: ServerDependencies,
): Promise<RunningServer>;
```

- [ ] **Step 1: Write failing configuration tests**

Cover:

- valid LAN configuration;
- missing database URL;
- invalid port;
- `COOKIE_SECURE` accepting only literal `true` or `false`;
- only one Telegram credential present must fail safely;
- secrets never appear in thrown validation messages.

- [ ] **Step 2: Implement strict configuration parsing**

Use an explicit allowlist and safe error codes. Do not spread `process.env` into logs or dependency objects.

- [ ] **Step 3: Write failing HTTP dispatch tests**

Cover:

- `/api/health`;
- every existing API route receives the same-origin `Request`;
- unknown `/api/*` returns JSON `404`;
- existing static asset is served with the correct type;
- non-API client route returns `index.html`;
- missing static file cannot escape the configured directory;
- request bodies above the configured limit return `413`;
- auth Cookie contains `HttpOnly`, `SameSite=Strict`, and the configured `Secure` state.

- [ ] **Step 4: Implement Hono/Node request composition**

Use Hono only as the Node/Fetch adapter. Preserve the existing route dispatch functions and standard responses. Resolve static paths under one normalized build root and reject traversal before filesystem access.

- [ ] **Step 5: Separate frontend and server builds**

Remove `@cloudflare/vite-plugin` from Vite configuration. Build React to `dist/client` and bundle the Node entry with tsup to `dist/server`, preserving source maps outside the production image if they could expose local paths.

Required scripts:

```json
{
  "dev": "concurrently --kill-others-on-fail \"npm:dev:server\" \"npm:dev:client\"",
  "dev:server": "tsx watch src/server/index.ts",
  "dev:client": "vite",
  "build": "npm run build:client && npm run build:server",
  "build:client": "vite build",
  "build:server": "tsup",
  "start": "node dist/server/index.js"
}
```

Pin exact compatible dependency versions through `package-lock.json`.

- [ ] **Step 6: Add graceful HTTP shutdown tests**

Start on an ephemeral port, begin one in-flight request, send the shutdown signal through an injectable lifecycle controller, assert new connections stop, and assert the in-flight response completes within the configured grace period.

- [ ] **Step 7: Run the Node server gate**

Run:

```bash
npx vitest run test/server-config.test.ts test/server-http.test.ts test/server-shutdown.test.ts
npm run test:dom -- --run
npx tsc --noEmit
npm run build
git diff --check
```

Expected: all commands exit zero and build output contains `dist/client` and `dist/server`.

- [ ] **Step 8: Request commit confirmation, then commit and push**

After explicit approval:

```bash
git add src/server test/server-*.test.ts vite.config.ts tsup.config.ts \
  tsconfig.json package.json package-lock.json
git commit -m "feat: add node http runtime"
git push
```

---

### Task 6: Replace Cloudflare Cron with an Advisory-Locked Scheduler

**Files:**
- Create: `src/server/scheduler.ts`
- Create: `test/server-scheduler.test.ts`
- Modify: `src/server/dependencies.ts`
- Modify: `src/server/index.ts`
- Modify: `src/services/scheduler-service.ts`
- Modify: `test/scheduler-service.test.ts`
- Modify: `test/six-hour-collection.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Existing `runScheduled`, `runPendingNotificationDelivery`, and `runSixHourCollection`; `AppDatabase.withAdvisoryLock`.
- Produces:

```ts
export interface SchedulerClock {
  everyMinute(callback: (scheduledAt: Date) => void): { stop(): void };
  everySixHours(callback: (scheduledAt: Date) => void): { stop(): void };
}

export interface SchedulerDependencies {
  database: AppDatabase;
  runMinute(scheduledAt: string): Promise<void>;
  runSixHour(scheduledAt: string): Promise<void>;
  recordSafeFailure(input: { task: "minute" | "six-hour"; scheduledAt: string }): void;
}

export interface SchedulerHandle {
  stop(): void;
  waitForIdle(timeoutMs: number): Promise<boolean>;
}

export function startScheduler(
  dependencies: SchedulerDependencies,
  clock?: SchedulerClock,
): SchedulerHandle;
```

- [ ] **Step 1: Write failing scheduler lifecycle tests**

Using a fake clock, prove:

- the minute job calls daily-report and pending-notification paths;
- the six-hour job calls collection and retention once;
- a held advisory lock skips, rather than queues, the duplicate trigger;
- an exception is converted to a safe log event and later triggers still run;
- `stop()` prevents new work;
- `waitForIdle()` returns true on completion and false on grace timeout.

- [ ] **Step 2: Run the scheduler tests to verify RED**

Expected: FAIL because `startScheduler` does not exist.

- [ ] **Step 3: Implement scheduler triggers and distinct lock keys**

Use fixed documented `bigint` lock keys for minute and six-hour tasks. Capture the scheduled instant once and pass its ISO value into existing services. Never infer local system timezone.

- [ ] **Step 4: Connect scheduler and process shutdown**

Startup order:

1. validate config;
2. connect and migrate PostgreSQL;
3. build dependencies;
4. start HTTP;
5. start scheduler.

Shutdown order:

1. stop scheduler triggers;
2. stop accepting HTTP;
3. wait for HTTP and scheduled work within the grace period;
4. close Playwright resources;
5. close PostgreSQL pool.

- [ ] **Step 5: Run focused and full service tests**

Run scheduler, notification, report, retention, live collection, manual refresh, and server shutdown tests, followed by typecheck and build.

- [ ] **Step 6: Request commit confirmation, then commit and push**

After explicit approval:

```bash
git add src/server src/services/scheduler-service.ts test package.json package-lock.json
git commit -m "feat: add postgres-locked scheduler"
git push
```

---

### Task 7: Replace Browser Binding with Local Playwright Chromium

**Files:**
- Move/replace: `src/worker/providers/japanese-upgrade-browser.ts` → `src/providers/playwright/japanese-upgrade-browser.ts`
- Create: `src/providers/playwright/browser-launcher.ts`
- Create: `test/playwright-browser-launcher.test.ts`
- Modify: `test/japanese-upgrade-browser.test.ts`
- Modify: `test/japanese-upgrade-relation-service.test.ts`
- Modify: `src/server/dependencies.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Existing `JapaneseUpgradeBrowserBatch`, `JapaneseUpgradeBrowserResult`, and relation service contracts.
- Produces:

```ts
export interface BrowserPageLike {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
  locator(selector: string): {
    all(): Promise<Array<{
      isVisible(): Promise<boolean>;
      innerText(): Promise<string>;
      getAttribute(name: "href"): Promise<string | null>;
    }>>;
  };
  close(): Promise<void>;
}

export interface BrowserContextLike {
  newPage(): Promise<BrowserPageLike>;
  close(): Promise<void>;
}

export interface BrowserLike {
  newContext(): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

export interface BrowserLauncher {
  launch(): Promise<BrowserLike>;
}

export function createLocalBrowserLauncher(options: {
  executablePath?: string;
  headless: true;
}): BrowserLauncher;

export function createJapaneseUpgradeBrowserBatch(
  launcher: BrowserLauncher,
): JapaneseUpgradeBrowserBatch;
```

- [ ] **Step 1: Preserve the current lifecycle regression baseline**

Run the Japanese browser and relation tests before changing the adapter. Record counts for success, timeout, abort, late resource delivery, close rejection, invalid URL, multiple matches, and batch-limit cases.

- [ ] **Step 2: Write failing local-launcher tests**

Use an injected Playwright module to prove:

- exactly one launch per non-empty batch;
- zero launches for empty or wholly invalid roots;
- `headless: true`;
- no remote endpoint, CDP session, persistent context, or debugging port;
- launch failure maps to `browser-unavailable` without error text leakage.

- [ ] **Step 3: Replace Cloudflare launch with local Playwright**

Keep the existing narrow `BrowserLike`, `BrowserContextLike`, and `BrowserPageLike` interfaces. Only `browser-launcher.ts` imports Playwright. The relation adapter never receives database or Telegram dependencies.

- [ ] **Step 4: Add a real Chromium smoke test**

The smoke test launches the installed browser, navigates to a local fixture server, extracts one allowed link, and closes the page/context/browser. It must not call Nintendo or require internet access.

Run:

```bash
npx vitest run test/playwright-browser-launcher.test.ts test/japanese-upgrade-browser.test.ts \
  test/japanese-upgrade-relation-service.test.ts
```

Expected: all pass with no leaked Chromium process after completion.

- [ ] **Step 5: Remove Cloudflare Playwright package usage**

Remove `@cloudflare/playwright` from dependencies only after all tests import the local adapter. Verify:

```bash
rg -n '@cloudflare/playwright|BrowserWorker|BROWSER' src test package.json
```

Expected: no production match.

- [ ] **Step 6: Run the browser and product-flow gate**

Run all browser, official discovery, Japanese confirmation, product preview, subscription confirmation, type, and build tests.

- [ ] **Step 7: Request commit confirmation, then commit and push**

After explicit approval:

```bash
git add src/providers src/server/dependencies.ts test package.json package-lock.json
git commit -m "feat: run japanese discovery in local playwright"
git push
```

---

### Task 8: Build Reproducible Local and Production Containers

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `.env.example`
- Create: `docker-compose.prod.yml`
- Modify: `docker-compose.dev.yml`
- Create: `test/docker-config.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Node build/start scripts, PostgreSQL migrations, and local Playwright from Tasks 2–7.
- Produces: Native arm64 local development/production images and an amd64-compatible production Dockerfile.

- [ ] **Step 1: Write failing Docker contract tests**

Parse Dockerfile and Compose configs to assert:

- Node.js and PostgreSQL major versions are pinned;
- production has only `app` and `postgres` as always-on services;
- production app uses `image:` and has no `build:`;
- database has no host `ports`;
- application runs as non-root with init and health check;
- Chromium debugging ports are absent;
- `.env`, `.git`, tests, local data, and secrets are excluded from build context;
- application image receives no secret build arguments;
- production uses an exact `${APP_VERSION}` reference.

- [ ] **Step 2: Run contract tests to verify RED**

Run:

```bash
node --test test/docker-config.test.mjs
```

Expected: FAIL because the production Docker assets do not exist.

- [ ] **Step 3: Implement the multi-stage Dockerfile**

Stages must:

1. install locked dependencies;
2. run frontend/server builds;
3. install the exact Playwright Chromium and system dependencies;
4. copy only production artifacts and production dependencies;
5. create and use a non-root application user;
6. use an init process and a health-checkable entrypoint.

Do not use Alpine because Playwright browser binaries require supported glibc distributions.

- [ ] **Step 4: Implement development and production Compose**

Development may expose PostgreSQL on loopback and mount source for debugging. Production:

```yaml
services:
  app:
    image: ${DOCKERHUB_IMAGE}:${APP_VERSION}
    depends_on:
      postgres:
        condition: service_healthy
  postgres:
    image: postgres:17
    expose:
      - "5432"
```

Add Chinese comments stating that `expose` is internal metadata and no database port is published to the NAS.

- [ ] **Step 5: Build and run the M1 production image**

Run:

```bash
docker buildx build --load --platform linux/arm64 -t switch-price-monitor:local .
DOCKERHUB_IMAGE=switch-price-monitor APP_VERSION=local \
  docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
```

Expected: both services become healthy.

- [ ] **Step 6: Run container smoke acceptance**

Verify health, static frontend, initialization status, one authenticated API flow using fake credentials, PostgreSQL port isolation, container user ID, and local Chromium fixture navigation. Do not use real Telegram or Nintendo credentials.

- [ ] **Step 7: Stop the local production stack and verify persistence**

Restart containers without deleting the data directory and confirm initialized state persists. Then use a separate disposable test directory for clean-start tests; never recursively delete an unresolved path.

- [ ] **Step 8: Request commit confirmation, then commit and push**

After explicit approval:

```bash
git add Dockerfile .dockerignore .env.example docker-compose.dev.yml \
  docker-compose.prod.yml test/docker-config.test.mjs package.json
git commit -m "feat: add multi-arch docker runtime"
git push
```

---

### Task 9: Add Safe PostgreSQL Backup and Restore

**Files:**
- Create: `scripts/backup-postgres.sh`
- Create: `scripts/restore-postgres.sh`
- Create: `test/postgres-backup-restore.test.mjs`
- Modify: `.env.example`
- Modify: `docker-compose.prod.yml`

**Interfaces:**
- Consumes: Production PostgreSQL container and configured `${BACKUP_DIR}`.
- Produces:

```text
scripts/backup-postgres.sh
  Input: explicit Compose project, database service, backup directory, retention count
  Output: one atomically renamed custom-format dump or non-zero exit

scripts/restore-postgres.sh
  Input: explicit dump path and empty target database
  Output: restored schema/data with migration validation or non-zero exit
```

- [ ] **Step 1: Write failing backup/restore integration tests**

Cover:

- successful compressed custom-format backup;
- temporary file is not left as a valid final backup;
- failed dump preserves prior backup;
- retention keeps exactly the configured newest files;
- restore rejects a non-empty target;
- restore into a fresh database preserves migration rows, administrator state, and representative price/history rows.

- [ ] **Step 2: Run tests to verify RED**

Expected: FAIL because scripts do not exist.

- [ ] **Step 3: Implement backup with explicit validated paths**

Require an absolute backup directory under the configured project root, create a task-specific temporary filename, call the PostgreSQL client version matching the server major version, then atomically rename only on success. Quote every path and never use `rm -rf`, globs over unresolved directories, `$HOME`, or `~`.

- [ ] **Step 4: Implement restore with empty-target guard**

Stop if the target contains application tables. Restore to an explicitly named target, run migrations in verification mode, and query required tables before reporting success.

- [ ] **Step 5: Run the full backup/restore gate**

Run integration tests twice: once from a fresh database and once after an application schema/data fixture. Confirm no credential value appears in output.

- [ ] **Step 6: Request commit confirmation, then commit and push**

After explicit approval:

```bash
git add scripts/backup-postgres.sh scripts/restore-postgres.sh \
  test/postgres-backup-restore.test.mjs .env.example docker-compose.prod.yml
git commit -m "feat: add postgres backup and restore"
git push
```

---

### Task 10: Add CI and Tagged Multi-Architecture Docker Hub Releases

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release-image.yml`
- Create: `test/github-actions-release.test.mjs`
- Modify: `docs/quality/quality-and-acceptance.md`
- Modify: `docs/README.md`

**Interfaces:**
- Consumes: all test/build scripts and Dockerfile from previous tasks; GitHub Secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN`.
- Produces: PR/push validation and `v*`-tagged public Docker Hub manifests.

- [ ] **Step 1: Write failing workflow contract tests**

Parse workflows and assert:

- PR and branch pushes run tests, typecheck, build, PostgreSQL integration, Chromium smoke, Docker build, secret scan, and comment consistency;
- PR workflow never logs in or pushes;
- release triggers only on `v*` tags;
- release repeats the complete quality gate before login;
- login reads only the two named GitHub Secrets;
- Buildx platforms equal `linux/arm64,linux/amd64`;
- tags include full semver, major/minor, `sha-${GIT_SHA_SHORT}`, and stable `latest`;
- ordinary branches cannot update `latest`;
- actions and base images use pinned versions.

- [ ] **Step 2: Run workflow tests to verify RED**

Expected: FAIL because the workflows do not exist.

- [ ] **Step 3: Implement CI with PostgreSQL service and Chromium**

Use a PostgreSQL 17 service container and the same migration/test commands as local development. Cache npm and Buildx layers by lockfile and Dockerfile hash; never cache runtime data or secrets.

- [ ] **Step 4: Implement tagged release**

Derive and validate semver from `github.ref_name`, build both platforms, attach OCI source/revision/version metadata, and push only after every gate succeeds.

Do not place secret values in command-line echoes. Use Docker login action password input from `secrets.DOCKERHUB_TOKEN`.

- [ ] **Step 5: Validate workflow syntax and dry-run tag mapping**

Run local contract tests and a script fixture for `v1.2.3`, expecting:

```text
${DOCKERHUB_IMAGE}:1.2.3
${DOCKERHUB_IMAGE}:1.2
${DOCKERHUB_IMAGE}:sha-${GIT_SHA_SHORT}
${DOCKERHUB_IMAGE}:latest
```

- [ ] **Step 6: Document one-time repository setup**

Document creating a public Docker Hub repository and adding the two GitHub Secrets. Never record the actual username token or copy a real token into screenshots.

- [ ] **Step 7: Request commit confirmation, then commit and push**

After explicit approval:

```bash
git add .github/workflows test/github-actions-release.test.mjs \
  docs/quality/quality-and-acceptance.md docs/README.md
git commit -m "ci: publish multi-arch docker images"
git push
```

Do not create a release tag until the user separately confirms the exact version and external Docker Hub publication.

---

### Task 11: Complete NAS Documentation, Remove Cloudflare Runtime, and Perform Final Cutover Gates

**Files:**
- Delete after replacement: `src/worker/index.ts`
- Delete after replacement: `wrangler.jsonc`
- Delete after replacement: `scripts/deploy-production.mjs`
- Delete/replace: Cloudflare-only test configuration and tests
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `vitest.config.mts`
- Modify: `docs/architecture/system-design.md`
- Modify: `docs/architecture/data-model.md`
- Modify: `docs/architecture/api-design.md`
- Modify: `docs/quality/quality-and-acceptance.md`
- Modify: `docs/requirements/traceability.md`
- Modify: `docs/decisions/ADR-001-cloudflare-workers-d1.md`
- Modify: `docs/decisions/ADR-003-nas-docker-postgresql.md`
- Create: `docs/deployment/synology-ds423-plus.md`
- Create: `docs/deployment/docker-hub-release.md`
- Create: `docs/deployment/postgres-backup-restore.md`
- Modify: `docs/README.md`

**Interfaces:**
- Consumes: Complete Node/PostgreSQL/Playwright/Docker/GitHub Actions implementation.
- Produces: One supported production path, exact Synology deployment instructions, full local and container acceptance evidence, and a separately authorized Cloudflare retirement checklist.

- [ ] **Step 1: Write failing final platform-removal checks**

Add a test or verification script that fails on production references to:

```text
@cloudflare/vite-plugin
@cloudflare/vitest-pool-workers
@cloudflare/workers-types
@cloudflare/playwright
wrangler
D1Database
ExportedHandler
BrowserWorker
```

Allow historical documentation to mention Cloudflare, but production source, tests, package dependencies, and deployment config must not require it.

- [ ] **Step 2: Remove Cloudflare runtime and obsolete scripts**

Delete only after Node/PostgreSQL/Playwright equivalents pass. Replace the production version/deploy script with semantic Git tag release documentation; ordinary local builds must still never mutate `package.json`.

- [ ] **Step 3: Update architecture and operational documentation**

Document:

- M1 development commands;
- M1 production Compose acceptance;
- GitHub Actions and Docker Hub version flow;
- DS423+ directory creation and `.env` permissions;
- Container Manager or SSH Compose pull/start/health commands;
- first initialization;
- logs and safe diagnostics;
- backup schedule and restore rehearsal;
- exact-version upgrade and rollback;
- `COOKIE_SECURE=false` LAN boundary and future HTTPS switch.

- [ ] **Step 4: Run the complete local quality gate**

Run:

```bash
npm test -- --run
npm run test:dom -- --run
npx tsc --noEmit
npm run build
node --test test/docker-config.test.mjs test/github-actions-release.test.mjs \
  test/postgres-backup-restore.test.mjs
git diff --check
```

Also run PostgreSQL integration and real local Chromium smoke tests with their documented commands.

Expected: every command exits zero with exact counts recorded in the quality document.

- [ ] **Step 5: Run M1 production Compose acceptance**

From a fresh disposable data directory:

1. start the arm64 production image;
2. initialize administrator;
3. verify login/logout/recovery/lockout;
4. verify settings, discovery fixtures, subscription transaction, history, export, manual refresh fixture, scheduler locks, Telegram fake transport, and local Chromium fixture;
5. back up and restore to a new empty database;
6. restart and verify persistence;
7. confirm database and debug ports are not published.

- [ ] **Step 6: Request commit confirmation, then commit and push**

Report all local and Compose evidence and the exact deletions. After explicit approval:

```bash
git add -A
git commit -m "feat: complete nas docker migration"
git push
```

The staged review must prove unrelated user files are excluded before using `git add -A`; if unrelated changes exist, stage exact paths/hunks instead.

- [ ] **Step 7: Request separate release-tag authorization**

State the exact version, Docker Hub repository, commit SHA, image tags, and external publication effect. Only after explicit confirmation create and push the tag:

```bash
git tag -a v0.1.0 -m "release: v0.1.0"
git push origin v0.1.0
```

Wait for GitHub Actions to finish, verify both manifest platforms and image metadata, then record the release evidence.

- [ ] **Step 8: Deploy the pinned image to DS423+**

On the NAS, use the documented production Compose and a fresh PostgreSQL directory. Verify:

- both containers healthy;
- first initialization and authenticated UI;
- PostgreSQL/internal ports not published;
- local Chromium fixture and one authorized real Japanese upgrade relation;
- one authorized five-region manual refresh;
- Telegram only if the user supplies test credentials for this step;
- backup creation and restore rehearsal;
- exact-version rollback command.

Do not include any real secret, Cookie, recovery code, page body, browser session, or database password in evidence.

- [ ] **Step 9: Request separate Cloudflare retirement authorization**

Present NAS acceptance evidence and list the exact Worker, D1 database, Cron triggers, Browser Binding, secrets, and deployment resources proposed for removal. Cloudflare deletion is destructive and is not implied by code completion or NAS deployment.

Only after explicit authorization, export non-sensitive final configuration records, remove the exact Cloudflare resources, verify the NAS remains healthy, and update ADR-001/ADR-003 plus quality evidence in a final confirmed commit-and-push cycle.

---

## Final Verification Matrix

| Requirement | Primary task | Final evidence |
| --- | --- | --- |
| Full Cloudflare runtime removal | 1, 5–7, 11 | Platform-removal scan and package lock |
| Fresh PostgreSQL schema and transactions | 2–4 | Constraint, rollback, concurrency tests |
| Single-admin authentication parity | 4–5 | Auth integration and HTTP Cookie tests |
| Five-region business parity | 3–7, 11 | Existing provider/service suites plus authorized NAS refresh |
| Minute and six-hour scheduling | 6 | Fake clock and advisory-lock tests |
| Local Japanese upgrade browser | 7–8 | Lifecycle suite, local fixture, authorized NAS sample |
| M1 local debugging | 5, 7–8 | Native arm64 dev and production Compose gates |
| PostgreSQL backup/restore | 9, 11 | Fresh-target restore integration and NAS rehearsal |
| Docker Hub multi-architecture publication | 8, 10–11 | Buildx manifest with arm64 and amd64 |
| NAS pulls pinned image only | 8, 11 | Production Compose and DS423+ acceptance |
| Secret exclusion | every task | staged diff scan, image inspection, log review |
| Documentation and rollback | 9–11 | deployment guides and recorded rehearsal |
