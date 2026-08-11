import { resolve } from "node:path";

/** Node 入口经过校验后可向依赖装配层暴露的唯一运行配置；不会携带整个 process.env。 */
export interface ServerConfig {
  port: number;
  databaseUrl: string;
  cookieSecure: boolean;
  /** 仅本机开发显式开启时允许无密码直入；生产和 NAS 缺省为 false，不能依赖 NODE_ENV 等可漂移推断。 */
  localDevelopmentAuthBypass: boolean;
  staticDirectory: string;
  maximumBodyBytes: number;
  shutdownGraceMs: number;
  telegramBotToken?: string;
  telegramChatId?: string;
  /** 仅在私有运行环境配置了非空 Key 时存在；依赖装配据此决定是否启用可选 AI，不会让秘密流向浏览器。 */
  deepSeekApiKey?: string;
  /** 与 Key 成对暴露的受控模型枚举，避免环境变量把任意模型名称或第三方端点策略带入外部请求。 */
  deepSeekModel?: "deepseek-v4-flash" | "deepseek-v4-pro";
}

const DEFAULT_PORT = 3000;
const DEFAULT_MAXIMUM_BODY_BYTES = 1_048_576;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const MAXIMUM_BODY_BYTES_LIMIT = 10_485_760;
const MINIMUM_SHUTDOWN_GRACE_MS = 100;
const MAXIMUM_SHUTDOWN_GRACE_MS = 120_000;
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash" as const;
const DEEPSEEK_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

/**
 * 只读取 Node 服务明确允许的十一项环境变量，并把错误限制为固定代码。
 * 数据库 URL 与 Telegram 凭据从不进入错误正文，调用方也无法借返回对象取得无关环境秘密。
 */
export function readServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  const databaseUrl = readRequiredSecret(
    environment.DATABASE_URL,
    "DATABASE_URL_REQUIRED",
  );
  const cookieSecure = readStrictBoolean(
    environment.COOKIE_SECURE,
    "COOKIE_SECURE_INVALID",
  );
  const localDevelopmentAuthBypass = readOptionalStrictBoolean(
    environment.LOCAL_DEVELOPMENT_AUTH_BYPASS,
    false,
    "LOCAL_DEVELOPMENT_AUTH_BYPASS_INVALID",
  );
  const telegramBotToken = readOptionalSecret(environment.TELEGRAM_BOT_TOKEN);
  const telegramChatId = readOptionalSecret(environment.TELEGRAM_CHAT_ID);
  // AI 是可选的管理员预填能力：空白 Key 不阻止既有手工名称流程，也不把无效空白凭据交给后续 HTTP 客户端。
  const deepSeekApiKey = readOptionalNonBlankSecret(environment.DEEPSEEK_API_KEY);
  const deepSeekModel = readDeepSeekModel(environment.DEEPSEEK_MODEL);
  if ((telegramBotToken === undefined) !== (telegramChatId === undefined)) {
    throw new Error("TELEGRAM_CREDENTIALS_INCOMPLETE");
  }

  const staticDirectoryValue = environment.STATIC_DIRECTORY ?? "dist/client";
  if (staticDirectoryValue.trim().length === 0) {
    throw new Error("STATIC_DIRECTORY_INVALID");
  }

  return {
    databaseUrl,
    port: readIntegerInRange(
      environment.PORT,
      DEFAULT_PORT,
      0,
      65_535,
      "PORT_INVALID",
    ),
    cookieSecure,
    localDevelopmentAuthBypass,
    // 入口只保存规范化绝对根；静态服务仍会对每个目标执行 realpath 根包含检查，防止符号链接逃逸。
    staticDirectory: resolve(staticDirectoryValue),
    maximumBodyBytes: readIntegerInRange(
      environment.MAXIMUM_BODY_BYTES,
      DEFAULT_MAXIMUM_BODY_BYTES,
      1,
      MAXIMUM_BODY_BYTES_LIMIT,
      "MAXIMUM_BODY_BYTES_INVALID",
    ),
    shutdownGraceMs: readIntegerInRange(
      environment.SHUTDOWN_GRACE_MS,
      DEFAULT_SHUTDOWN_GRACE_MS,
      MINIMUM_SHUTDOWN_GRACE_MS,
      MAXIMUM_SHUTDOWN_GRACE_MS,
      "SHUTDOWN_GRACE_MS_INVALID",
    ),
    ...(telegramBotToken === undefined
      ? {}
      : { telegramBotToken, telegramChatId }),
    // 模型配置不能在 Key 缺失时单独泄漏到依赖层，以免将“未配置”误判为可调用的 AI 服务。
    ...(deepSeekApiKey === undefined ? {} : { deepSeekApiKey, deepSeekModel }),
  };
}

/** 必填秘密只判断非空，不在异常中插值原值，避免启动日志泄漏连接凭据。 */
function readRequiredSecret(value: string | undefined, errorCode: string): string {
  if (value === undefined || value.trim().length === 0) throw new Error(errorCode);
  return value;
}

/** 可选秘密的空字符串等同于未配置；真实值保持原样交给对应客户端，绝不打印或正规化。 */
function readOptionalSecret(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * DeepSeek Key 的空白值等同未配置；保留非空原值而不 trim 或记录，避免误改供应商签名材料或把秘密写入错误信息。
 * 此规则只用于可选 AI 凭据，Telegram 的既有“空字符串”合同保持不变。
 */
function readOptionalNonBlankSecret(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

/**
 * 模型即使 Key 暂缺也必须先校验：部署拼写错误应在启动时以固定代码发现，而不是日后配置 Key 后静默请求未知模型。
 * 只允许产品确认过的两个标识，错误绝不拼接环境原值，防止运维日志回显秘密或不可信文本。
 */
function readDeepSeekModel(value: string | undefined): typeof DEEPSEEK_MODELS[number] {
  if (value === undefined) return DEFAULT_DEEPSEEK_MODEL;
  if (!DEEPSEEK_MODELS.includes(value as typeof DEEPSEEK_MODELS[number])) {
    throw new Error("DEEPSEEK_MODEL_INVALID");
  }
  return value as typeof DEEPSEEK_MODELS[number];
}

/**
 * 安全布尔值只接受小写字面量，禁止 Boolean("false") 或宽松大小写在部署时意外启用/关闭 Cookie Secure。
 * 局域网 HTTP 也必须显式设置 false，不能依据可伪造转发头或隐式默认值降级。
 */
function readStrictBoolean(value: string | undefined, errorCode: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(errorCode);
}

/**
 * 本机免登录只能由显式小写 true 开启，缺失时固定关闭；不能借 NODE_ENV、监听地址或 Cookie Secure 推断，
 * 因为这些条件会在 Docker、NAS 反向代理和测试环境中变化，可能把管理入口意外暴露给局域网或公网。
 */
function readOptionalStrictBoolean(
  value: string | undefined,
  defaultValue: boolean,
  errorCode: string,
): boolean {
  if (value === undefined) return defaultValue;
  return readStrictBoolean(value, errorCode);
}

/** 运行资源上限必须是无符号十进制整数且处于封闭区间，拒绝指数、小数、符号和隐式截断。 */
function readIntegerInRange(
  value: string | undefined,
  defaultValue: number,
  minimum: number,
  maximum: number,
  errorCode: string,
): number {
  if (value === undefined) return defaultValue;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(errorCode);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(errorCode);
  }
  return parsed;
}
