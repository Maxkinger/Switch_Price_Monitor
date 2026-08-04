import { defineConfig } from "vite";

/** Node 服务独立 SSR 构建只输出 dist/server/index.js；数据库连接串和 Telegram 秘密均由启动环境注入，不进入 bundle。 */
export default defineConfig({
  build: {
    ssr: "src/server/entry.ts",
    outDir: "dist/server",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { output: { entryFileNames: "index.js" } },
  },
});
