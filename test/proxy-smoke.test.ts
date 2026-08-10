import { once } from "node:events";
import { createServer, request as requestHttp, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createOutboundNetwork } from "../src/server/network/outbound-network";
import { proxyFetch } from "../src/server/network/proxy-agent-factory";

/** 本机代理冒烟仅使用随机回环端口，证明真实 Agent 转发和统一出站快照不会访问任天堂、Telegram 或开发者代理。 */
describe("local proxy transport smoke", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    // 每个监听器都只由本例创建；关闭时先停止接受连接，防止 keep-alive 句柄让 Vitest 或 CI 继续悬挂。
    await Promise.all(servers.splice(0).map(closeServer));
  });

  it("forwards a loopback HTTP request through an unauthenticated proxy snapshot", async () => {
    // 目标和正向代理都限制为 127.0.0.1，真实 socket 验证 Agent 行为但不会泄露 NAS 网络或命中外部服务。
    const target = createServer((_request, response) => response.end("fixture-ok"));
    const targetPort = await listen(target);
    servers.push(target);
    const proxy = createServer((incoming, outgoing) => {
      const destination = new URL(incoming.url ?? "");
      if (destination.protocol !== "http:" || destination.hostname !== "127.0.0.1") {
        outgoing.writeHead(403).end();
        return;
      }
      const upstream = requestHttp(destination, { method: incoming.method, headers: incoming.headers }, (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      });
      upstream.on("error", () => outgoing.writeHead(502).end());
      incoming.pipe(upstream);
    });
    const proxyPort = await listen(proxy);
    servers.push(proxy);
    const settings = { enabled: true, protocol: "http" as const, host: "127.0.0.1", port: proxyPort };
    const network = createOutboundNetwork({ settings: { readProxySettings: async () => settings }, proxyFetch });

    const response = await (await network.snapshot()).fetch(`http://127.0.0.1:${targetPort}/robots.txt`);
    await expect(response.text()).resolves.toBe("fixture-ok");
  });
});

/** 监听器固定回环随机端口，避免与本机开发服务或 PostgreSQL 测试端口冲突。 */
async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("LOOPBACK_PROXY_FIXTURE_ADDRESS_UNAVAILABLE");
  return address.port;
}

/** close 错误不遮蔽主体断言；所有服务器由当前测试创建，失败后也不能遗留监听端口。 */
async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
