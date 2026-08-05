import type { TelegramMessage } from "./report-service";

/** Telegram 只能接收非幂等发送函数，Node 装配据此使用带 HEAD 预检的统一出站会话，避免误用可自动回退的读取边界。 */
export type TelegramSender = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Telegram 凭据只由 Worker Secret 或后续加密设置提供；该模型绝不被 API 或日志直接返回。 */
export interface TelegramConfiguration {
  botToken: string;
  chatId: string;
}

/** 单页发送结果仅含安全的序号与 HTTP 状态，排除 URL、Token、Chat ID 和 Telegram 原始错误正文。 */
export interface TelegramDeliveryResult {
  index: number;
  delivered: boolean;
  status: number | null;
}

/**
 * Telegram 发送边界按分页顺序串行投递日报。串行而非 Promise.all 能让“第 n/m 页”保持聊天中的阅读顺序，
 * 单页失败后仍继续尝试后续页，确保临时错误不会让全部订阅信息都被放弃。
 */
export class TelegramService {
  /**
   * 第二个参数将配置与传输隔离。历史 Worker 仍可显式采用默认原生 fetch；Node 运行时必须由依赖装配传入统一 send 会话，
   * 以保证代理预检后的 POST 结果不明时不会被直连重发。
   */
  public constructor(private readonly configuration: TelegramConfiguration, private readonly sender: TelegramSender = fetch) {}

  /**
   * 逐条调用 Telegram sendMessage。发送体使用 JSON 防止长中文文本在 URL 中泄露或被错误编码，
   * 返回结果只保留可用于通知事件审计的状态码，任何第三方响应正文都不进入数据库或日志。
   */
  public async send(messages: TelegramMessage[]): Promise<TelegramDeliveryResult[]> {
    const results: TelegramDeliveryResult[] = [];
    for (const [index, message] of messages.entries()) {
      try {
        const response = await this.sender(`https://api.telegram.org/bot${this.configuration.botToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: this.configuration.chatId, text: message.text, disable_web_page_preview: true }),
        });
        results.push({ index, delivered: response.ok, status: response.status });
      } catch {
        // 网络、DNS 或超时异常没有可靠 HTTP 状态；统一返回 null，避免异常对象携带请求 URL 或凭据进入调用方日志。
        results.push({ index, delivered: false, status: null });
      }
    }
    return results;
  }
}
