import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/** 容器合同只读取提交配置，保证代理功能不通过特权网络、Docker Socket 或认证环境变量扩大 NAS 攻击面。 */
const root = new URL("..", import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), "utf8");
}

test("keeps proxy settings in PostgreSQL without privileged networking", async () => {
  // bridge 网络即可访问管理员选择的局域网代理；host 网络、特权容器和 Docker Socket 都会突破应用最小权限边界。
  const compose = await read("docker-compose.prod.yml");
  const envExample = await read(".env.example");
  const dockerfile = await read("Dockerfile");
  const ci = await read(".github/workflows/ci.yml");
  const migration = await read("migrations/postgres/0003_proxy_settings.sql");

  assert.doesNotMatch(compose, /network_mode:\s*host|privileged:\s*true|docker\.sock/);
  assert.doesNotMatch(envExample, /PROXY_(URL|USERNAME|PASSWORD)|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /api\/health/);
  assert.match(migration, /proxy_enabled/);
  assert.match(migration, /proxy_protocol/);
  assert.match(migration, /proxy_host/);
  assert.match(migration, /proxy_port/);
  assert.match(ci, /proxy-agent-factory\.test\.ts/);
  assert.match(ci, /proxy-smoke\.test\.ts/);
});
