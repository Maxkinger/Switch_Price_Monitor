# DeepSeek 设置页加密配置设计规格

**日期：** 2026-08-11

**状态：** 已确认设计，待实施

## 1. 目标

管理员在设置页填写 DeepSeek API Key、模型名称和 API 地址。三项配置在服务重启后仍可使用，但 Key 不会返回浏览器、日志、普通设置接口、导出、备份说明或错误响应。

配置只用于生成“待管理员确认”的中文名称草稿；不会改变官方商品身份、跨区匹配、价格、订阅、词条或现有人工保存流程。

## 2. 安全边界

- 浏览器只通过同源、已认证的设置接口提交 Key；读取接口只返回 `configured`、模型和官方地址，绝不返回或掩码回显 Key。
- PostgreSQL 只保存经过 AES-256-GCM 加密的完整配置载荷、随机 nonce 和算法版本。不得拆分或明文保存 API Key、模型、API 地址。
- 唯一主密钥为 Node 进程私有环境变量 `AI_CREDENTIAL_ENCRYPTION_KEY`。它必须解码为 32 字节随机值，不能保存到 PostgreSQL、设置页、镜像、日志、测试快照或 Git。
- 每次保存都必须生成新的随机 nonce；AES-GCM 认证失败、密文损坏、算法版本未知或主密钥缺失时，服务返回固定“AI 名称建议尚未配置或不可用”状态，不泄漏具体解密原因。
- API 地址输入框允许管理员手动填写，但服务端只接受严格规范化后的 `https://api.deepseek.com`。拒绝其他主机、HTTP、端口、用户名密码、查询参数、片段和任意路径；服务端自行拼出固定 `/chat/completions` 路径，禁止重定向，避免 Key 被发送给非官方目标。
- 模型名称允许管理员手动填写，经修剪后限制为 1–128 个可打印字符且不含 C0/C1 控制字符；它不改变请求地址、认证或数据库权限。

## 3. 数据与加密模型

新增单例 `ai_provider_configuration` 表，固定 `id = 1`，包含：

- `ciphertext BYTEA NOT NULL`：UTF-8 JSON 载荷 `{ apiKey, model, apiBaseUrl }` 的 AES-256-GCM 密文；
- `nonce BYTEA NOT NULL`：每次写入新生成的 12 字节随机 nonce；
- `algorithm_version SMALLINT NOT NULL`：当前为 `1`，为未来轮换预留；
- `updated_at TIMESTAMPTZ NOT NULL`。

API Key、模型和 API 地址同包加密，避免数据库泄漏元数据。写入以单条参数化 UPSERT 原子替换；删除配置直接删除单例行。迁移不得改写既有 `settings` 单例或历史迁移。

`AI_CREDENTIAL_ENCRYPTION_KEY` 丢失或更换后无法解密旧密文。管理员可在设置页删除旧配置并重新填写；系统不得尝试弱化加密或回退为明文。

## 4. 服务与 HTTP 合同

新增 `AiProviderConfigurationService`，负责校验、加密、解密、读取摘要和清除。它通过窄仓储端口访问密文，DeepSeek 调用服务只读取解密后的瞬时内存对象。

新增同源管理员接口：

| 接口 | 请求/响应 | 规则 |
| --- | --- | --- |
| `GET /api/settings/ai-provider` | 响应 `{ configured, model: string \| null, apiBaseUrl: string \| null }` | 从不返回 Key；密文不可读或主密钥缺失时返回 `configured: false`。 |
| `PUT /api/settings/ai-provider` | 请求 `{ apiKey, model, apiBaseUrl }` | 三项完整校验后加密原子替换；`apiKey` 为 1–512 字符且无控制字符。 |
| `DELETE /api/settings/ai-provider` | 响应 `204` | 删除持久化密文，后续 AI 请求立即返回不可用状态。 |

这些接口与其他设置接口一样要求真实管理员会话；本机开发旁路仅在显式 `LOCAL_DEVELOPMENT_AUTH_BYPASS=true` 且 Node 已绑定 `127.0.0.1` 时适用。任何环境都不允许通过请求覆盖主密钥。

DeepSeek 建议服务不再从 `DEEPSEEK_API_KEY` 或 `DEEPSEEK_MODEL` 读取启动环境。每次建议前读取加密配置，只有成功解密、校验地址和模型后才创建外部请求；配置不存在或不可解密时由名称建议路由返回固定 `503 AI_NOT_CONFIGURED`。原有 `AI_UNAVAILABLE` 保留给已配置后的网络、超时和供应商失败。

## 5. 设置页行为

设置页新增“DeepSeek AI 配置”卡片：

1. 未配置时显示 Key、模型、API 地址输入框和“保存配置”。
2. 已配置时 Key 输入框保持空白占位“已保存，重新输入可替换”；模型和地址显示已解密的非秘密值。保存时必须提供完整 Key，以防浏览器从读取接口获得或复用旧 Key。
3. “清除配置”需要明确二次确认，成功后仅移除 AI 配置，不影响地区、主题、代理、Telegram、订阅或人工中文名称。
4. 保存或清除期间只禁用本卡片控件；错误使用固定中文摘要，不显示密文、主密钥、上游正文或数据库异常。

设置页不提供“显示 Key”、复制 Key、自动测试请求或把配置写入浏览器持久化存储的能力。DeepSeek 调用仍仅在管理员执行地区核验或名称管理页“生成 AI 建议”时发生。

## 6. 配置与部署

`.env.example` 与部署文档删除 `DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`，改为只说明 `AI_CREDENTIAL_ENCRYPTION_KEY` 的私有部署方式。该主密钥应以 `openssl rand -base64 32` 在可信本机生成并保存在权限为 `600` 的私有环境文件；不得打印、截图、提交或写入 NAS 数据库备份。

生产 Compose 只将主密钥传给 `app` 容器，绝不传给 PostgreSQL；本机开发也必须显式设置主密钥，避免在无加密保护时创建配置。旧环境变量即使存在也被忽略，防止双配置来源。

## 7. 测试与验收

- 迁移与仓储：单例 UPSERT、删除、密文不含明文 Key/模型/地址、不同 nonce、历史设置不受影响。
- 加密服务：AES-GCM 解密、篡改、错误主密钥、缺失主密钥、未知版本和非法输入均返回固定安全状态。
- HTTP：未经认证为 401；GET 永不返回 Key；PUT/DELETE 的 422/204 合同、官方地址限制及旁路边界正确。
- 设置页 DOM：保存后只显示状态/非秘密字段；刷新后仍显示配置；替换需重新输入 Key；清除后 AI 不可用；错误不泄漏秘密。
- AI 回归：配置保存后无需重启即可生效；删除、密文损坏或主密钥缺失时不调用 DeepSeek；原有名称草稿、认证、URL 最小化、零持久化和人工确认测试继续通过。

## 8. 明确排除项

- 不支持任意第三方兼容地址、代理地址或自定义端口。
- 不提供主密钥在设置页配置、在线轮换、历史密文恢复、Key 显示或导出。
- 不改变 AI 仅生成待确认草稿、管理员确认才保存的业务规则。
- 不在本轮恢复生产认证或授权 NAS/公网部署。
