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
