import { spawnSync } from "node:child_process";

/**
 * 生产发布只能按“版本递增、构建、部署”的顺序执行；先递增让页面构建产物携带新批次，
 * 任何一步失败都会立即停止，避免在构建失败后仍错误发布旧资源。脚本不读取或打印任何 Secret。
 */
const releaseSteps = [
  ["npm", ["version", "patch", "--no-git-tag-version"]],
  ["npm", ["run", "build"]],
  ["npx", ["wrangler", "deploy"]],
];

for (const [command, argumentsList] of releaseSteps) {
  // inherit 保留 Wrangler 的正常认证交互；每次只运行一个固定命令，禁止拼接管理员输入防止命令注入。
  const result = spawnSync(command, argumentsList, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
