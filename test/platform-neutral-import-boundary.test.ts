import { describe, expect, it } from "vitest";

// 以原始源码文本而非执行模块进行扫描，确保测试本身不会加载 Cloudflare 专属依赖；五个目录中的业务逻辑必须能被后续 Node 运行时安全复用。
const platformNeutralSources = import.meta.glob("../src/{routes,services,repositories,providers,shared}/**/*.ts", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

describe("platform-neutral source boundary", () => {
  it("does not statically import Worker implementation modules", () => {
    // 静态导入会在模块求值前装载 @cloudflare/playwright 等运行时专属依赖；即使仅使用类型或错误类，也必须经由平台中立契约目录传递。
    const workerImports = Object.entries(platformNeutralSources)
      .filter(([, source]) => /\bfrom\s*["'][^"']*(?:^|\/)worker\//u.test(source))
      .map(([path]) => path)
      .sort();

    expect(workerImports).toEqual([]);
  });
});
