import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production Worker pins the verified Browser Run stack", async () => {
  // 此配置测试只读取受版本控制的清单与 Wrangler 文件，不启动远程浏览器、不会部署，也不会请求任天堂站点。
  // 固定已通过可行性验证的 CDP 依赖组合，防止未来宽松版本范围在安装时静默升级而绕过生产验证边界。
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const wrangler = JSON.parse(stripJsonComments(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")));

  assert.equal(manifest.devDependencies["@cloudflare/playwright"], "1.3.0");
  assert.equal(manifest.devDependencies.wrangler, "4.112.0");
  assert.equal(manifest.devDependencies["@cloudflare/workers-types"], "5.20260714.1");
  assert.equal(wrangler.browser.binding, "BROWSER");
  assert.deepEqual(wrangler.compatibility_flags, ["nodejs_compat"]);
  assert.equal(wrangler.compatibility_date, "2026-07-16");
});

/**
 * 仅为读取仓库内的 JSONC 配置移除行与块注释；Wrangler 配置当前不包含字符串中的注释标记，
 * 因而此最小解析器足以让测试聚焦于生产绑定与版本约束，而不额外引入运行时解析依赖。
 */
function stripJsonComments(value) {
  // Wrangler 的资源通配符 `/api/*` 和 Cron 表达式 `*/6` 都可能含有注释分隔符；解析器只能在 JSON 字符串外识别注释，
  // 否则会删除真实配置并把绑定缺失误报为生产问题。该状态机只满足本仓库 JSONC 的行/块注释语法，不承担通用 JSONC 解析职责。
  let result = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    const nextCharacter = value[index + 1];

    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') {
      inString = true;
      result += character;
      continue;
    }

    if (character === "/" && nextCharacter === "/") {
      index = value.indexOf("\n", index + 2);
      if (index === -1) break;
      // 让 for 循环在下一轮重新处理换行，既保留 JSON 的行边界，也不会跳过下一行可能无缩进的首字符。
      index -= 1;
      continue;
    }

    if (character === "/" && nextCharacter === "*") {
      const commentEnd = value.indexOf("*/", index + 2);
      index = commentEnd === -1 ? value.length : commentEnd + 1;
      continue;
    }

    result += character;
  }

  return result;
}
