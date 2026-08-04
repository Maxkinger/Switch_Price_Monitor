/** Node 服务启动时使用的最小、已校验配置；敏感值只在依赖装配阶段短暂传递，不进入日志或 HTTP 响应。 */
export interface ServerConfig {
  port: number;
  databaseUrl: string;
  cookieSecure: boolean;
  staticDirectory: string;
  maximumBodyBytes: number;
  shutdownGraceMs: number;
  telegramBotToken?: string;
  telegramChatId?: string;
}

/** 启动配置错误只暴露稳定代码，防止把数据库连接串、Telegram 凭据或环境变量原文写入错误日志。 */
export class ServerConfigError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = "ServerConfigError";
  }
}

/**
 * 从显式环境变量读取 Node 运行时配置。LAN HTTP 必须显式设置 COOKIE_SECURE=false，
 * Telegram Bot Token 与 Chat ID 要么同时提供、要么同时缺省；部分秘密配置会造成日报行为不确定，必须在启动前拒绝。
 */
export function readServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  const databaseUrl = required(environment.DATABASE_URL, "DATABASE_URL_REQUIRED");
  const staticDirectory = required(environment.STATIC_DIRECTORY ?? "dist/client", "STATIC_DIRECTORY_REQUIRED");
  const port = integer(environment.PORT ?? "3000", 1, 65535, "PORT_INVALID");
  const maximumBodyBytes = integer(environment.MAXIMUM_BODY_BYTES ?? "1048576", 1, 16 * 1024 * 1024, "MAXIMUM_BODY_BYTES_INVALID");
  const shutdownGraceMs = integer(environment.SHUTDOWN_GRACE_MS ?? "10000", 1, 120000, "SHUTDOWN_GRACE_MS_INVALID");
  if (environment.COOKIE_SECURE !== "true" && environment.COOKIE_SECURE !== "false") throw new ServerConfigError("COOKIE_SECURE_INVALID");
  const telegramBotToken = optional(environment.TELEGRAM_BOT_TOKEN);
  const telegramChatId = optional(environment.TELEGRAM_CHAT_ID);
  if (Boolean(telegramBotToken) !== Boolean(telegramChatId)) throw new ServerConfigError("TELEGRAM_CONFIGURATION_INCOMPLETE");
  return {
    port,
    databaseUrl,
    cookieSecure: environment.COOKIE_SECURE === "true",
    staticDirectory,
    maximumBodyBytes,
    shutdownGraceMs,
    ...(telegramBotToken && telegramChatId ? { telegramBotToken, telegramChatId } : {}),
  };
}

function required(value: string | undefined, code: string): string {
  if (!value || value.trim().length === 0) throw new ServerConfigError(code);
  return value;
}

function optional(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function integer(value: string, minimum: number, maximum: number, code: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new ServerConfigError(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new ServerConfigError(code);
  return parsed;
}
