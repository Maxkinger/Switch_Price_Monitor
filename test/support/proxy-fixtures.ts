import http, { type Server } from "node:http";
import net, { type Server as NetServer, type Socket } from "node:net";

/** 本机网络夹具的最小生命周期；URL 仅指向 127.0.0.1 随机端口，测试结束后必须主动释放监听器和连接。 */
export interface RunningFixture {
  url: string;
  close(): Promise<void>;
}

/**
 * 启动固定成功响应的本地 HTTP 目标。
 * 响应正文不包含真实商品、代理地址或外部数据，只用于证明代理 Agent 已取得完整 HTTP 响应。
 */
export async function startTargetFixture(): Promise<RunningFixture> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("fixture-ok");
  });
  return listen(server);
}

/**
 * 启动无认证 HTTP 正向代理的最小转发夹具。
 * 它仅接受绝对 HTTP URL 并转发到测试调用给出的回环目标；拒绝非 HTTP scheme，避免测试夹具意外成为通用网络访问通道。
 */
export async function startHttpProxyFixture(): Promise<RunningFixture> {
  const server = http.createServer((request, response) => {
    let target: URL;
    try {
      target = new URL(request.url ?? "");
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
      response.writeHead(403).end();
      return;
    }
    const upstream = http.request(target, {
      method: request.method,
      headers: request.headers,
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => response.writeHead(502).end());
    request.pipe(upstream);
  });
  return listen(server);
}

/**
 * 启动仅支持无认证 CONNECT 的 SOCKS5 夹具。
 * 协议实现故意只接受代理端发往 127.0.0.1 的测试目标，验证 `socks5h` Agent 的握手与转发，同时杜绝测试成为任意内网探测器。
 */
export async function startSocks5ProxyFixture(): Promise<RunningFixture> {
  const server = net.createServer((client) => {
    let buffer = Buffer.alloc(0);
    let negotiated = false;
    let established = false;
    client.on("data", (chunk) => {
      if (established) return;
      // Node 类型允许 data 事件传入 string；socket 默认不会设置编码，但这里仍显式转为 Buffer，避免分包解析误把字符长度当字节长度。
      buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (!negotiated) {
        if (buffer.length < 2) return;
        const methodsLength = buffer[1];
        if (buffer.length < 2 + methodsLength) return;
        if (buffer[0] !== 0x05 || !buffer.subarray(2, 2 + methodsLength).includes(0x00)) {
          client.end(Buffer.from([0x05, 0xff]));
          return;
        }
        client.write(Buffer.from([0x05, 0x00]));
        buffer = buffer.subarray(2 + methodsLength);
        negotiated = true;
      }
      const request = readSocks5ConnectRequest(buffer);
      if (!request) return;
      const { host, port, consumed } = request;
      buffer = buffer.subarray(consumed);
      if (host !== "127.0.0.1") {
        client.end(Buffer.from([0x05, 0x02, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        return;
      }
      const upstream = net.connect({ host, port });
      upstream.once("connect", () => {
        established = true;
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]));
        if (buffer.length > 0) upstream.write(buffer);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.once("error", () => client.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])));
    });
  });
  return listen(server);
}

/**
 * 从累计字节中解析一条 SOCKS5 CONNECT 请求；返回 null 代表分包尚未收齐，不能把暂态数据误判为代理错误。
 * 夹具支持 IPv4 与域名两种寻址，正好覆盖 `socks5h` 由代理端解析域名的安全语义。
 */
function readSocks5ConnectRequest(buffer: Buffer): { host: string; port: number; consumed: number } | null {
  if (buffer.length < 4 || buffer[0] !== 0x05 || buffer[1] !== 0x01 || buffer[2] !== 0x00) return null;
  if (buffer[3] === 0x01) {
    if (buffer.length < 10) return null;
    return { host: Array.from(buffer.subarray(4, 8)).join("."), port: buffer.readUInt16BE(8), consumed: 10 };
  }
  if (buffer[3] === 0x03) {
    if (buffer.length < 5) return null;
    const length = buffer[4];
    if (buffer.length < 7 + length) return null;
    return { host: buffer.subarray(5, 5 + length).toString("utf8"), port: buffer.readUInt16BE(5 + length), consumed: 7 + length };
  }
  return null;
}

/**
 * 监听器只绑定 IPv4 回环和随机端口；活动 socket 会在 close 时销毁，避免代理或 keep-alive 连接让 Vitest 悬挂。
 * 夹具不记录请求 URL，确保测试日志不会意外写入完整连接路径或未来的凭据样式输入。
 */
async function listen(server: Server | NetServer): Promise<RunningFixture> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试代理未取得回环端口。");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
