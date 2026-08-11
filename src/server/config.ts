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
  /**
   * 仅 Node 进程保有的 AES-256-GCM 主密钥。它解不开浏览器数据、不会写入数据库或响应；缺失时仍可启动，
   * 但已保存的 AI 密文统一视为不可用，以保留手工中文名称流程。
   */
  aiCredentialEncryptionKey?: Uint8Array;
}

const DEFAULT_PORT = 3000;
const DEFAULT_MAXIMUM_BODY_BYTES = 1_048_576;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const MAXIMUM_BODY_BYTES_LIMIT = 10_485_760;
const MINIMUM_SHUTDOWN_GRACE_MS = 100;
const MAXIMUM_SHUTDOWN_GRACE_MS = 120_000;

/**
 * 只读取 Node 服务明确允许的环境变量，并把错误限制为固定代码。
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
  // AI 是可选的管理员草稿能力；旧 DeepSeek 环境变量故意完全不读取，防止出现绕过数据库加密的第二配置来源。
  const aiCredentialEncryptionKey = readOptionalAiCredentialEncryptionKey(environment.AI_CREDENTIAL_ENCRYPTION_KEY);
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
    ...(aiCredentialEncryptionKey === undefined ? {} : { aiCredentialEncryptionKey }),
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
 * 主密钥只能以标准 Base64 传入并解码为恰好 32 字节；Buffer 的宽松解码会接受部分垃圾字符，
 * 所以除字节长度外还要用规范编码反向比对。错误永远不包含原环境值，避免启动日志泄漏主密钥。
 */
function readOptionalAiCredentialEncryptionKey(value: string | undefined): Uint8Array | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) {
    throw new Error("AI_CREDENTIAL_ENCRYPTION_KEY_INVALID");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new Error("AI_CREDENTIAL_ENCRYPTION_KEY_INVALID");
  }
  return new Uint8Array(decoded);
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
