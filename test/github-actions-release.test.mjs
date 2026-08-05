import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

/**
 * 本合同测试把 GitHub Actions YAML 解析为对象后验证可执行结构，避免仅靠文本片段误判触发器、
 * 权限、登录顺序或多架构发布行为。测试只注入公开假镜像名和假提交 SHA，绝不读取真实 Secrets。
 */
const repositoryRoot = resolve(import.meta.dirname, "..");
const workflowPaths = {
  ci: ".github/workflows/ci.yml",
  release: ".github/workflows/release-image.yml",
};
// PostgreSQL 破坏性集成测试只能连接本机 Compose 的一次性端口；此字面量必须同时与工作流和安全守卫一致。
const disposablePostgresUrl =
  "postgres://switch_test:switch_test@127.0.0.1:54329/switch_test";
/**
 * Gitleaks 历史基线只允许七个已经人工核验的精确指纹：公开只读任天堂搜索配置，
 * 以及认证计划中的固定测试密码。指纹包含提交、路径、规则和行号，不能退化为按规则或整文件放行。
 */
const acceptedHistoricalLeakFingerprints = [
  "cde06674220cd5fb37542507cd20ddbe3689312d:src/worker/providers/official-nintendo-search.ts:algolia-api-key:11",
  "2786df5de0deb1f3be307b75e4ba702a8f580577:docs/superpowers/plans/2026-07-17-authentication-entry.md:generic-api-key:60",
  "2786df5de0deb1f3be307b75e4ba702a8f580577:docs/superpowers/plans/2026-07-17-authentication-entry.md:generic-api-key:63",
  "2786df5de0deb1f3be307b75e4ba702a8f580577:docs/superpowers/plans/2026-07-17-authentication-entry.md:generic-api-key:74",
  "2786df5de0deb1f3be307b75e4ba702a8f580577:docs/superpowers/plans/2026-07-17-authentication-entry.md:generic-api-key:158",
  "2786df5de0deb1f3be307b75e4ba702a8f580577:docs/superpowers/plans/2026-07-17-authentication-entry.md:generic-api-key:163",
  "fe4da7f57f97ae260b9bf3a0729223acb93d4ad6:src/worker/providers/official-nintendo-search.ts:generic-api-key:11",
];
/**
 * 固定表来自对应官方仓库的具体版本标签；合同同时验证 action 名与完整提交，
 * 防止把任意 40 位字符串误当成可信 pin，版本升级必须在审查后显式修改此表。
 */
const trustedActionPins = {
  "actions/checkout": "de0fac2e4500dabe0009e67214ff5f5447ce83dd",
  "actions/setup-node": "48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
  "docker/setup-qemu-action": "96fe6ef7f33517b61c61be40b68a1882f3264fb8",
  "docker/setup-buildx-action": "bb05f3f5519dd87d3ba754cc423b652a5edd6d2c",
  "docker/login-action": "dbcb813823bdd20940b903addbd779551569679f",
  "docker/build-push-action": "53b7df96c91f9c12dcc8a07bcb9ccacbed38856a",
};
const workflowFilesExist = Object.values(workflowPaths).every((path) =>
  existsSync(resolve(repositoryRoot, path)));

test("提供普通 CI 与标签发布两个工作流", () => {
  const missing = Object.values(workflowPaths).filter((path) =>
    !existsSync(resolve(repositoryRoot, path)));
  assert.deepEqual(missing, [], `缺少 GitHub Actions 工作流：${missing.join(", ")}`);
});

/**
 * 工作流缺失时只保留上方单一、可解释的 RED；文件出现后再解除其余合同，避免 ENOENT 掩盖真实失败。
 */
const contractTest = (name, implementation) =>
  test(name, { skip: !workflowFilesExist }, implementation);

contractTest("普通 push 与 PR 运行完整质量门禁且没有发布权限", () => {
  const ci = readWorkflow("ci");
  const trigger = ci.parsed.on;
  const quality = ci.parsed.jobs?.quality;

  assert.ok(trigger?.push?.branches, "普通 CI 必须监听分支 push");
  assert.ok(trigger?.pull_request !== undefined, "普通 CI 必须监听 pull_request");
  assert.equal(trigger.push.tags, undefined, "普通 CI 不得监听发布标签");
  assert.equal(ci.parsed.permissions?.contents, "read");
  assert.deepEqual(
    stepIds(quality),
    [
      "checkout",
      "initialize_postgres_role",
      "setup_node",
      "install_dependencies",
      "install_chromium",
      "unit_and_integration",
      "dom",
      "chromium_smoke",
      "proxy_transport",
      "typecheck",
      "production_build",
      "docker_contract",
      "workflow_contract",
      "comment_consistency",
      "whitespace",
      "secret_scan",
      "setup_qemu",
      "setup_buildx",
      "docker_build",
    ],
  );
  assertPostgresAndBrowserGate(quality);
  assertPinnedActions(quality);
  assert.equal(findUses(quality, "docker/login-action"), undefined);

  const dockerBuild = findStep(quality, "docker_build");
  assert.equal(dockerBuild.with?.push, false);
  assert.equal(dockerBuild.with?.platforms, "linux/arm64,linux/amd64");
  assert.match(dockerBuild.with?.["cache-from"], /hashFiles\('package-lock\.json', 'Dockerfile'\)/);
  assert.match(dockerBuild.with?.["cache-to"], /hashFiles\('package-lock\.json', 'Dockerfile'\)/);
  const serializedCi = JSON.stringify(ci.parsed);
  assert.doesNotMatch(serializedCi, /\blatest\b|docker\/login-action/);
  // 普通 CI 不应获得发布身份：除明确镜像名外，任何 GitHub Secret 表达式或 Docker Hub 用户名/token 都是越权。
  assert.doesNotMatch(serializedCi, /\$\{\{\s*secrets\./i);
  assert.doesNotMatch(serializedCi, /\bDOCKERHUB_(?:TOKEN|USERNAME)\b/);
});

contractTest("标签发布只接受 v* 且完整质量门禁在登录前成功", () => {
  const release = readWorkflow("release");
  const trigger = release.parsed.on;
  const quality = release.parsed.jobs?.quality;
  const publish = release.parsed.jobs?.publish;

  assert.deepEqual(trigger?.push?.tags, ["v*"]);
  assert.equal(trigger.push.branches, undefined);
  assert.equal(trigger.pull_request, undefined);
  assert.equal(release.parsed.permissions?.contents, "read");
  assert.deepEqual(
    release.parsed.concurrency,
    {
      group: "release-${{ github.repository }}",
      "cancel-in-progress": false,
    },
    "同一仓库的标签发布必须进入不可取消的单一队列",
  );
  assertPostgresAndBrowserGate(quality);
  assertPinnedActions(quality);
  assert.equal(findUses(quality, "docker/login-action"), undefined);
  assert.equal(findStep(quality, "docker_build").with?.push, false);
  assert.equal(publish.needs, "quality");

  const publishIds = stepIds(publish);
  const versionGuardIndex = publishIds.indexOf("release_version_guard");
  const metadataIndex = publishIds.indexOf("release_metadata");
  const loginIndex = publishIds.indexOf("dockerhub_login");
  const pushIndex = publishIds.indexOf("publish_image");
  assert.equal(
    findStep(publish, "checkout").with?.["fetch-depth"],
    0,
    "最高语义版本守卫必须取得全部仓库标签",
  );
  assert.ok(
    versionGuardIndex >= 0 && versionGuardIndex < loginIndex,
    "最高语义版本守卫必须在 Docker Hub 登录之前",
  );
  assert.ok(metadataIndex >= 0 && metadataIndex < loginIndex, "语义版本验证必须在登录之前");
  assert.ok(loginIndex >= 0 && loginIndex < pushIndex, "登录后才允许执行唯一推送步骤");
  assertPinnedActions(publish);
});

contractTest("发布只引用两个 Docker Hub Secrets 并精确构建双架构 manifest", () => {
  const release = readWorkflow("release").parsed;
  const publish = release.jobs.publish;
  const secretNames = [
    ...new Set(
      [...JSON.stringify(release).matchAll(/secrets\.([A-Z0-9_]+)/g)]
        .map((match) => match[1]),
    ),
  ].sort();

  assert.deepEqual(secretNames, ["DOCKERHUB_TOKEN", "DOCKERHUB_USERNAME"]);
  const login = findStep(publish, "dockerhub_login");
  assert.equal(login.with?.username, "${{ secrets.DOCKERHUB_USERNAME }}");
  assert.equal(login.with?.password, "${{ secrets.DOCKERHUB_TOKEN }}");
  assert.equal(
    login.with?.scope,
    "${{ env.DOCKERHUB_IMAGE }}@push",
    "登录凭据必须只注入目标镜像的 Buildx push scope",
  );

  const publishImage = findStep(publish, "publish_image");
  assert.equal(publishImage.with?.push, true);
  assert.equal(publishImage.with?.platforms, "linux/arm64,linux/amd64");
  assert.equal(publishImage.with?.tags, "${{ steps.release_metadata.outputs.tags }}");
  assert.match(publishImage.with?.labels, /org\.opencontainers\.image\.source=/);
  assert.match(publishImage.with?.labels, /org\.opencontainers\.image\.revision=/);
  assert.match(publishImage.with?.labels, /org\.opencontainers\.image\.version=/);
  assert.match(publishImage.with?.labels, /org\.opencontainers\.image\.created=/);
});

contractTest("v1.2.3 fixture 生成完整、次版本、短 SHA 与 latest 标签", () => {
  const release = readWorkflow("release").parsed;
  const metadata = findStep(release.jobs.publish, "release_metadata");
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "switch-release-contract-"));
  const outputPath = join(fixtureDirectory, "github-output.txt");
  const fullSha = "0123456789abcdef0123456789abcdef01234567";

  try {
    execFileSync("bash", ["-c", metadata.run], {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH,
        DOCKERHUB_IMAGE: "example/switch-price-monitor",
        GITHUB_REF_NAME: "v1.2.3",
        GITHUB_SHA: fullSha,
        GITHUB_OUTPUT: outputPath,
      },
      stdio: "pipe",
    });
    const outputs = parseGithubOutput(readFileSync(outputPath, "utf8"));
    assert.equal(outputs.version, "1.2.3");
    assert.equal(outputs.git_sha_short, "0123456789ab");
    assert.deepEqual(outputs.tags.split("\n"), [
      "example/switch-price-monitor:1.2.3",
      "example/switch-price-monitor:1.2",
      "example/switch-price-monitor:sha-0123456789ab",
      "example/switch-price-monitor:latest",
    ]);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

contractTest("非法、带前导零或落后于仓库最高版本的标签在登录前被拒绝", () => {
  const release = readWorkflow("release").parsed;
  const metadata = findStep(release.jobs.publish, "release_metadata");
  const versionGuard = findStep(
    release.jobs.publish,
    "release_version_guard",
  );
  const fixtureDirectory = mkdtempSync(
    join(tmpdir(), "switch-release-version-contract-"),
  );

  try {
    runGit(fixtureDirectory, ["init", "--quiet"]);
    runGit(fixtureDirectory, ["config", "user.name", "Switch Release CI"]);
    runGit(fixtureDirectory, ["config", "user.email", "release-ci@example.invalid"]);
    writeFileSync(join(fixtureDirectory, "fixture.txt"), "release fixture\n", "utf8");
    runGit(fixtureDirectory, ["add", "fixture.txt"]);
    runGit(fixtureDirectory, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"]);
    runGit(fixtureDirectory, ["tag", "v1.2.3"]);
    runGit(fixtureDirectory, ["tag", "v1.2.4"]);

    for (const refName of ["main", "v1.2", "v1.2.3-rc.1", "v01.2.3"]) {
      assert.throws(
        () =>
          execFileSync("bash", ["-c", versionGuard.run], {
            cwd: fixtureDirectory,
            env: {
              PATH: process.env.PATH,
              GITHUB_REF_NAME: refName,
            },
            stdio: "pipe",
          }),
        `${refName} 不得通过最高严格语义版本守卫`,
      );
      assert.throws(
        () =>
          execFileSync("bash", ["-c", metadata.run], {
            cwd: fixtureDirectory,
            env: {
              PATH: process.env.PATH,
              DOCKERHUB_IMAGE: "example/switch-price-monitor",
              GITHUB_REF_NAME: refName,
              GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
              GITHUB_OUTPUT: join(fixtureDirectory, "unused-switch-release-output"),
            },
            stdio: "pipe",
          }),
        `${refName} 不得通过发布元数据语义版本校验`,
      );
    }

    // 两个标签共存时直接执行 workflow 的精确守卫：旧标签必须失败，最高严格 semver 必须成功。
    assert.throws(
      () =>
        execFileSync("bash", ["-c", versionGuard.run], {
          cwd: fixtureDirectory,
          env: {
            PATH: process.env.PATH,
            GITHUB_REF_NAME: "v1.2.3",
          },
          stdio: "pipe",
        }),
      "存在 v1.2.4 时不得发布较旧的 v1.2.3",
    );
    assert.doesNotThrow(() =>
      execFileSync("bash", ["-c", versionGuard.run], {
        cwd: fixtureDirectory,
        env: {
          PATH: process.env.PATH,
          GITHUB_REF_NAME: "v1.2.4",
        },
        stdio: "pipe",
      }),
    );
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

contractTest("空白门禁检查触发提交范围而不是 checkout 后的干净工作区", () => {
  const ci = readWorkflow("ci").parsed;
  const whitespace = findStep(ci.jobs.quality, "whitespace");
  const releaseWhitespace = findStep(
    readWorkflow("release").parsed.jobs.quality,
    "whitespace",
  );
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "switch-whitespace-contract-"));

  try {
    assert.match(whitespace.env.DIFF_BASE_SHA, /pull_request\.base\.sha/);
    assert.match(whitespace.env.DIFF_BASE_SHA, /github\.event\.before/);
    assert.match(whitespace.run, /git diff --check "\$\{DIFF_BASE_SHA\}\.\.\.\$\{GITHUB_SHA\}"/);

    runGit(fixtureDirectory, ["init", "--quiet"]);
    runGit(fixtureDirectory, ["config", "user.name", "Switch CI"]);
    runGit(fixtureDirectory, ["config", "user.email", "ci@example.invalid"]);
    writeFileSync(join(fixtureDirectory, "fixture.txt"), "clean\n", "utf8");
    runGit(fixtureDirectory, ["add", "fixture.txt"]);
    runGit(fixtureDirectory, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "clean"]);
    const baseSha = runGit(fixtureDirectory, ["rev-parse", "HEAD"]).trim();
    // Git 的默认初始分支可由本机配置决定；记录真实分支名，避免 fixture 把环境差异误报为空白门禁失败。
    const baseBranch = runGit(fixtureDirectory, ["symbolic-ref", "--short", "HEAD"]).trim();

    // 把尾随空格提交进历史后，工作区仍然干净；裸 git diff --check 会错误通过，显式提交范围必须失败。
    writeFileSync(join(fixtureDirectory, "fixture.txt"), "bad trailing spaces   \n", "utf8");
    runGit(fixtureDirectory, ["add", "fixture.txt"]);
    runGit(fixtureDirectory, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "bad"]);
    const headSha = runGit(fixtureDirectory, ["rev-parse", "HEAD"]).trim();

    assert.throws(
      () =>
        execFileSync("bash", ["-c", whitespace.run], {
          cwd: fixtureDirectory,
          env: {
            PATH: process.env.PATH,
            DIFF_BASE_SHA: baseSha,
            GITHUB_SHA: headSha,
          },
          stdio: "pipe",
        }),
      "空白门禁必须拒绝已经提交、但 checkout 后工作区干净的尾随空格",
    );

    // 发布标签可能指向 merge commit：尾随空格只存在于被合并父分支时，未带 -m 的 diff-tree 会跳过该差异。
    // 直接执行工作流中的精确 shell，证明发布门禁必须展开每个父提交，而非只匹配命令文本。
    runGit(fixtureDirectory, ["checkout", "--quiet", "-b", "feature"]);
    writeFileSync(join(fixtureDirectory, "merge-fixture.txt"), "bad merge whitespace   \n", "utf8");
    runGit(fixtureDirectory, ["add", "merge-fixture.txt"]);
    runGit(fixtureDirectory, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "feature whitespace"]);
    runGit(fixtureDirectory, ["checkout", "--quiet", baseBranch]);
    runGit(fixtureDirectory, ["merge", "--no-ff", "--no-commit", "feature"]);
    runGit(fixtureDirectory, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "merge feature"]);
    const mergeSha = runGit(fixtureDirectory, ["rev-parse", "HEAD"]).trim();

    assert.throws(
      () =>
        execFileSync("bash", ["-c", releaseWhitespace.run], {
          cwd: fixtureDirectory,
          env: {
            PATH: process.env.PATH,
            GITHUB_SHA: mergeSha,
          },
          stdio: "pipe",
        }),
      "发布空白门禁必须拒绝只在 merge 父差异中出现的尾随空格",
    );
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});

contractTest("Actions、PostgreSQL 服务与扫描器均固定不可漂移版本", () => {
  for (const workflowName of Object.keys(workflowPaths)) {
    const workflow = readWorkflow(workflowName).parsed;
    for (const job of Object.values(workflow.jobs)) {
      assertPinnedActions(job);
    }
  }

  const ciQuality = readWorkflow("ci").parsed.jobs.quality;
  const releaseQuality = readWorkflow("release").parsed.jobs.quality;
  const dockerfile = readFileSync(resolve(repositoryRoot, "Dockerfile"), "utf8");
  const dockerBases = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)]
    .map((match) => match[1]);
  assert.deepEqual(
    dockerBases,
    [
      "node:22.20.0-bookworm-slim",
      "dependencies",
      "node:22.20.0-bookworm-slim",
      "node:22.20.0-bookworm-slim",
    ],
    "构建、生产依赖与运行阶段必须统一使用具体 Node 补丁版本",
  );
  assert.equal(ciQuality.services.postgres.image, "postgres:17.10-bookworm");
  assert.equal(releaseQuality.services.postgres.image, "postgres:17.10-bookworm");
  for (const quality of [ciQuality, releaseQuality]) {
    const secretScan = findStep(quality, "secret_scan");
    assert.equal(quality.env.GITLEAKS_VERSION, "8.30.1");
    assert.equal(
      quality.env.GITLEAKS_LINUX_X64_SHA256,
      "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    );
    assert.match(secretScan.run, /sha256sum --check/);
    assert.match(
      secretScan.run,
      /gitleaks git --gitleaks-ignore-path "\$\{GITHUB_WORKSPACE\}\/\.gitleaksignore" --redact --no-banner/,
      "秘密扫描必须用 GITHUB_WORKSPACE 锚定精确指纹文件，不能受 runner 当前工作目录或 defaults 漂移影响",
    );
  }
});

contractTest("Gitleaks 历史基线只放行七个已核验的精确指纹", () => {
  const ignorePath = resolve(repositoryRoot, ".gitleaksignore");
  assert.ok(existsSync(ignorePath), "缺少受审查的 Gitleaks 历史基线");
  const fingerprints = readFileSync(ignorePath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  assert.deepEqual(
    fingerprints,
    acceptedHistoricalLeakFingerprints,
    "历史基线只能逐条使用 Gitleaks 指纹，不得按路径、规则或正则扩大例外范围",
  );
});

contractTest("工作流中文注释与安全边界保持一致", () => {
  for (const workflowName of Object.keys(workflowPaths)) {
    const source = readWorkflow(workflowName).source;
    const chineseCommentLines = source
      .split("\n")
      .filter((line) => /^\s*#.*[\u3400-\u9fff]/u.test(line));
    assert.ok(chineseCommentLines.length >= 12, `${workflowName} 的中文职责/边界注释不足`);
    assert.match(source, /#.*(?:秘密|凭据|令牌)/u);
    assert.match(source, /#.*(?:缓存|lockfile|Dockerfile)/u);
    assert.match(source, /#.*(?:PostgreSQL|数据库)/u);
    assert.match(source, /#.*(?:Chromium|浏览器)/u);
  }
  const releaseSource = readWorkflow("release").source;
  assert.match(releaseSource, /#.*(?:标签|语义版本)/u);
  assert.match(releaseSource, /#.*(?:登录|推送).*质量/u);
});

function readWorkflow(name) {
  const source = readFileSync(resolve(repositoryRoot, workflowPaths[name]), "utf8");
  return { source, parsed: parse(source) };
}

function stepIds(job) {
  assert.ok(job, "缺少预期 job");
  return (job.steps ?? []).map((step) => step.id).filter(Boolean);
}

function findStep(job, id) {
  const step = (job?.steps ?? []).find((candidate) => candidate.id === id);
  assert.ok(step, `缺少步骤 id=${id}`);
  return step;
}

function findUses(job, actionName) {
  return (job?.steps ?? []).find((step) => step.uses?.startsWith(`${actionName}@`));
}

function assertPinnedActions(job) {
  for (const step of job?.steps ?? []) {
    if (!step.uses) continue;
    assert.match(
      step.uses,
      /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-f]{40}$/i,
      `${step.uses} 必须固定到不可变 40 位提交 SHA`,
    );
    const [actionName, revision] = step.uses.split("@");
    assert.equal(
      revision,
      trustedActionPins[actionName],
      `${actionName} 必须使用已经核对官方版本标签的可信提交`,
    );
  }
}

function assertPostgresAndBrowserGate(job) {
  assert.equal(job?.["runs-on"], "ubuntu-24.04");
  assert.equal(job?.services?.postgres?.image, "postgres:17.10-bookworm");
  // GitHub Actions 需要从 runner host 访问 service；发布 54329:5432 才与破坏性测试的单一安全守卫一致。
  assert.deepEqual(job?.services?.postgres?.ports, ["54329:5432"]);
  // 此合同防止工作流再次把 switch_test 交给官方镜像 bootstrap 成超级用户、跳过普通角色自检，或让 loopback trust 把错误应用密码误报为安全。
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
  assert.match(
    initializeRole.run,
    /PGPASSWORD="\$\{APP_DATABASE_PASSWORD\}" psql/,
    "自检必须实际把应用密码交给 psql，而不能只保留未使用的环境变量",
  );
  assert.match(
    initializeRole.run,
    /--username "\$\{APP_DATABASE_USER\}"/,
    "自检必须以普通应用角色登录，不能改用 bootstrap 管理角色绕过权限边界",
  );
  assert.match(
    initializeRole.run,
    /--host postgres/,
    "自检必须经 service 网络别名进入 SCRAM host 规则，才能验证应用密码",
  );
  assert.doesNotMatch(
    initializeRole.run,
    /--host 127\.0\.0\.1/,
    "自检不得使用 loopback trust；否则错误密码仍可能被 PostgreSQL 接受",
  );
  assert.match(
    initializeRole.run,
    /--command "SELECT rolcanlogin AND NOT \(\s*rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls\s*\) FROM pg_roles WHERE rolname = current_user"/s,
    "自检查询必须同时要求可登录并拒绝五项集群级权限",
  );
  assert.match(initializeRole.run, /rolcanlogin/);
  assert.match(initializeRole.run, /rolsuper/);
  assert.match(initializeRole.run, /rolcreaterole/);
  assert.match(initializeRole.run, /rolcreatedb/);
  assert.match(initializeRole.run, /rolreplication/);
  assert.match(initializeRole.run, /rolbypassrls/);
  assert.match(
    initializeRole.run,
    /test "\$\{role_is_safe\}" = "t"/,
    "自检必须把角色查询的唯一真值作为阻止后续测试的失败边界",
  );
  assert.equal(
    findStep(job, "unit_and_integration").env.TEST_DATABASE_URL,
    disposablePostgresUrl,
    "工作流连接串必须精确命中本地一次性 PostgreSQL 安全边界",
  );
  const postgresSafetyGuard = readFileSync(
    resolve(repositoryRoot, "test/support/postgres.ts"),
    "utf8",
  );
  assert.match(
    postgresSafetyGuard,
    /url\.hostname === "127\.0\.0\.1"\s*&&\s*url\.port === "54329"\s*&&\s*url\.username === "switch_test"\s*&&\s*url\.password === "switch_test"\s*&&\s*url\.pathname === "\/switch_test"/s,
    "CI 映射与连接串必须匹配 PostgreSQL 安全守卫允许的唯一目标",
  );
  assert.equal(
    findStep(job, "checkout").with?.["fetch-depth"],
    0,
    "秘密扫描必须取得完整历史，不能把 shallow clone 描述为全历史扫描",
  );
  assert.match(findStep(job, "unit_and_integration").run, /vitest run/);
  assert.match(findStep(job, "unit_and_integration").env.TEST_DATABASE_URL, /^postgres:\/\//);
  assert.match(findStep(job, "dom").run, /test:dom/);
  assert.match(findStep(job, "install_chromium").run, /playwright install --with-deps chromium/);
  assert.match(findStep(job, "chromium_smoke").run, /playwright-browser-launcher\.test\.ts/);
  // 代理协议回归只使用回环夹具；CI 必须显式执行 Agent 与冒烟两层，避免普通完整套件重排后悄然漏掉真实转发边界。
  assert.match(findStep(job, "proxy_transport").run, /proxy-agent-factory\.test\.ts/);
  assert.match(findStep(job, "proxy_transport").run, /proxy-smoke\.test\.ts/);
  assert.match(findStep(job, "typecheck").run, /tsc --noEmit/);
  assert.match(findStep(job, "production_build").run, /npm run build/);
  assert.match(findStep(job, "docker_contract").run, /test:docker-config/);
  assert.match(findStep(job, "workflow_contract").run, /test:github-actions/);
  assert.match(findStep(job, "comment_consistency").run, /test:workflow-comments/);
  // merge 提交需要 diff-tree -m 展开父差异；接受该选项但仍要求执行 Git 的空白检查，而不是仅检查工作区。
  assert.match(findStep(job, "whitespace").run, /git (?:diff|diff-tree)(?: -m)? --check/);
  assert.match(findStep(job, "secret_scan").run, /gitleaks/);
  assert.equal(findStep(job, "docker_build").with?.push, false);
}

/**
 * GitHub 多行输出采用 name<<delimiter 语法；解析器只处理本项目元数据步骤产生的受控文本，
 * 并拒绝缺失结束标记，避免测试在截断输出时误判标签合同。
 */
function parseGithubOutput(source) {
  const lines = source.split(/\r?\n/);
  const outputs = {};
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const multiline = /^([A-Za-z_][A-Za-z0-9_]*)<<(.+)$/.exec(line);
    if (multiline) {
      const [, name, delimiter] = multiline;
      const values = [];
      index += 1;
      while (index < lines.length && lines[index] !== delimiter) {
        values.push(lines[index]);
        index += 1;
      }
      assert.equal(lines[index], delimiter, `${name} 多行输出缺少结束标记`);
      outputs[name] = values.join("\n");
      continue;
    }
    const single = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (single) outputs[single[1]] = single[2];
  }
  return outputs;
}

function runGit(cwd, argumentsList) {
  return execFileSync("git", argumentsList, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
