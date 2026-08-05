import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("..", import.meta.url);

async function read(path) {
  return readFile(new URL(path, root), "utf8");
}

test("keeps proxy settings in PostgreSQL without privileged networking", async () => {
  // 容器使用普通 bridge 网络即可主动访问管理员填写的局域网代理；host、privileged 和 Docker Socket 会扩大攻击面，必须禁止。
  const compose = await read("docker-compose.prod.yml");
  const envExample = await read(".env.example");
  const dockerfile = await read("Dockerfile");
  const ci = await read(".github/workflows/ci.yml");
  const migration = await read("migrations/postgres/0002_proxy_settings.sql");

  assert.doesNotMatch(compose, /network_mode:\s*host|privileged:\s*true|docker\.sock/);
  assert.doesNotMatch(envExample, /PROXY_(URL|USERNAME|PASSWORD)|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /api\/health/);
  assert.match(migration, /proxy_enabled/);
  assert.match(migration, /proxy_protocol/);
  assert.match(migration, /proxy_host/);
  assert.match(migration, /proxy_port/);
  assert.match(ci, /proxy-agent-factory\.test\.ts/);
  assert.match(ci, /proxy-smoke\.test\.ts/);
});
