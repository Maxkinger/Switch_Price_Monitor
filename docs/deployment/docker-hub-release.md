# Docker Hub 多架构发布

状态：工作流与本地合同已实现；外部凭据、首个标签和公开镜像均未完成

## 1. 发布合同

普通分支与 Pull Request 只运行 `.github/workflows/ci.yml`：PostgreSQL 集成测试、DOM、真实 Chromium 生命周期、类型、构建、Docker/Actions 合同、注释一致性、空白检查、Gitleaks 和 `linux/arm64,linux/amd64` 构建验证。它不读取 Docker Hub Secrets、不登录、不推送。

`.github/workflows/release-image.yml` 仅由 Git 标签触发，并在登录前同时要求：

- 标签严格匹配无前导零的 `vX.Y.Z`；预发布后缀和不完整版本被拒绝。
- 当前标签仍是完整 Git 历史中的最高严格语义版本，防止旧任务回退浮动标签。
- 同一标签提交重新通过完整 quality job；不能复用普通 CI 的旧成功结果。

成功后发布同一个 `linux/arm64` + `linux/amd64` manifest 的四个标签：

```text
X.Y.Z
X.Y
sha-<提交前12位>
latest
```

NAS 只能将 `APP_VERSION` 固定为 `X.Y.Z`。`latest`、`X.Y` 与 `sha-*` 用于发现或审计，不作为生产 Compose 版本。

## 2. 一次性 Docker Hub 与 GitHub 设置

1. 在 Docker Hub 创建公开仓库 `switch-price-monitor`。公开仅代表镜像可匿名拉取；运行 `.env`、数据库、备份和秘密绝不能进入镜像。
2. 创建专用发布身份：组织方案优先使用只对该仓库授予 Pull/Push 的 OAT；个人方案使用只拥有该目标仓库的专用 Docker ID 与不含 Delete 的 Read/Write PAT。
3. 在 GitHub Repository Actions secrets 新增：
   - `DOCKERHUB_USERNAME`
   - `DOCKERHUB_TOKEN`
4. 不要在 Issue、PR、命令参数、截图或文档中粘贴值。Secret 无法从仓库恢复；疑似泄露时先在 Docker Hub 撤销，再轮换 GitHub Secret。

当前这两个 Secrets 尚未配置。

## 3. 发布前门禁

发布是外部写操作。每次创建标签前必须取得对精确版本和提交的独立确认，并确认：

- 当前工作树改动已提交、推送，目标提交是准备公开发布的内容。
- `package.json` 和 `package-lock.json` 的顶层版本已经在受审查提交中显式对齐到标签的 `X.Y.Z`，确保页面显示一致。当前工作流不会自动修改或校验这个值。
- M1 生产运行时 Compose 与业务自动化分层验收已于 2026-08-01 对当前工作树通过；发布前仍须确认后续代码未使该证据失效，且不得把 fake/fixture 证据表述为真实外部演练。
- 本地完整门禁通过。当前已记录的仓库门禁是 Vitest 69 文件/420 项、DOM 16 项、Chromium 4 项、Docker/平台合同 19/19、TypeScript 与构建通过。
- 远程普通 CI 对目标提交通过。run `30686052256` 是平台移除前提交的成功记录，不能作为当前工作树或未来标签的证据。
- 没有真实数据库、Telegram、Cookie、恢复码或 Docker Hub 凭据进入提交与构建上下文。

## 4. 创建首个正式发布

以下只是经确认后由仓库维护者执行的示例，不能在未授权时运行：

```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

当前 `v0.1.0` 尚未创建，也没有公开镜像。标签推送后，在 GitHub Actions 中等待 `Release Docker image` 的 quality 与 publish 两个 job 都成功。不要因 quality 成功就提前认为镜像已发布。

## 5. 发布后独立验证

在不显示登录凭据的终端验证 manifest 与两个平台，并用精确版本拉取：

```bash
docker buildx imagetools inspect <namespace>/switch-price-monitor:0.1.0
docker pull --platform linux/arm64 <namespace>/switch-price-monitor:0.1.0
docker pull --platform linux/amd64 <namespace>/switch-price-monitor:0.1.0
```

检查结果应包含 `linux/arm64` 和 `linux/amd64`。随后在 `.env` 设置相同的 `DOCKERHUB_IMAGE` 与 `APP_VERSION=0.1.0`，先执行 Compose `config -q`，再在 M1 和 NAS 分别完成生产形态验收。不要重新构建或手工覆盖同一版本标签。

## 6. 失败与版本策略

- 标签格式、最高版本守卫、质量门禁或登录失败时，不要移动、强推或复用已公开版本标签。修复后递增补丁版本重新发布。
- `package.json` 不是发布触发器，普通 build 不修改它；页面当前直接显示该已提交版本。因此维护者必须在标签前显式对齐，不能假定工作流会从 Git 标签注入页面版本。
- 若 token 失败，先确认身份与仓库权限，禁止把 token 打印出来排障。
- 删除公开镜像、移动浮动标签或撤销版本是独立破坏性操作，必须另行授权。
