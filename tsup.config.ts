import { defineConfig } from "tsup";

/**
 * Node 服务端只打包单一进程入口到 dist/server，目标与 Docker 运行时统一为 Node.js 22 ESM。
 * 不生成 source map，避免未来生产镜像误带本地绝对路径；类型正确性由独立 tsc 门禁负责。
 */
export default defineConfig({
  entry: ["src/server/index.ts"],
  outDir: "dist/server",
  format: ["esm"],
  platform: "node",
  target: "node22",
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
});
