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
      .flatMap(([path, source]) => findForbiddenStaticSpecifiers(source).map((specifier) => `${path}: ${specifier}`))
      .sort();

    expect(workerImports).toEqual([]);
  });

  it.each([
    ["普通 from 导入", 'import { adapter } from "../worker/providers/adapter";', ["../worker/providers/adapter"]],
    ["副作用 Worker 导入", 'import "../worker/providers/adapter";', ["../worker/providers/adapter"]],
    ["直接 Cloudflare Playwright 导入", 'import { launch } from "@cloudflare/playwright";', ["@cloudflare/playwright"]],
    ["Worker re-export", 'export { adapter } from "../worker/providers/adapter";', ["../worker/providers/adapter"]],
    ["允许的平台中立导入", 'import { contract } from "../providers/contract";', []],
  ])("classifies %s", (_name, source, expected) => {
    // 这里覆盖 TypeScript 静态模块语法中会在加载期建立依赖边的最小集合；动态 import 不属于本次静态边界检查，也不在这里执行或解析模块。
    expect(findForbiddenStaticSpecifiers(source)).toEqual(expected);
  });
});

/**
 * 从 TypeScript 源码文本中抽取静态 import、side-effect import 和 export-from 的模块说明符。
 * 正则刻意只覆盖本仓库使用的静态模块语法，不充当通用解析器；边界目标是阻止加载期依赖边，动态 import 不在此处执行也不纳入本轮约束。
 */
function findForbiddenStaticSpecifiers(source: string): string[] {
  const staticSpecifiers = Array.from(
    source.matchAll(/\b(?:import|export)\s+(?:(?:type\s+)?[\w$*{},\s]+\s+from\s+)?["']([^"']+)["']/gu),
    (match) => match[1],
  );
  // Worker 路径和 Playwright 包都会在模块求值时绑定 Cloudflare 实现；中立目录即使只是 re-export 或副作用加载也不能保留这类静态边。
  return staticSpecifiers.filter((specifier) => /(?:^|\/)worker(?:\/|$)/u.test(specifier)
    || specifier === "@cloudflare/playwright"
    || specifier.startsWith("@cloudflare/playwright/"));
}
