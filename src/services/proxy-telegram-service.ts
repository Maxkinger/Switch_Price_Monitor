import type { OutboundNetwork } from "../server/network/outbound-network";
import type { TelegramMessage } from "./report-service";
import { TelegramService, type TelegramConfiguration, type TelegramDeliveryResult } from "./telegram-service";

/**
 * Node 专用 Telegram 适配器在一次逻辑投递开始时获取一份出站网络快照。
 * 全部分页复用同一 send 边界，保证代理设置不会在投递中途切换，且真实 POST 保留未知结果不重发的安全规则。
 */
export class ProxyTelegramService {
  public constructor(private readonly configuration: TelegramConfiguration, private readonly outbound: Pick<OutboundNetwork, "snapshot">) {}

  /** 先建立一次会话再顺序发送分页；TelegramService 不接触设置、数据库或代理配置。 */
  public async send(messages: TelegramMessage[]): Promise<TelegramDeliveryResult[]> {
    const session = await this.outbound.snapshot();
    return new TelegramService(this.configuration, session.send.bind(session)).send(messages);
  }
}
