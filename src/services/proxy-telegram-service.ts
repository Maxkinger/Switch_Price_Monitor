import type { OutboundNetwork } from "../server/network/outbound-network";
import type { TelegramMessage } from "./report-service";
import { TelegramService, type TelegramConfiguration, type TelegramDeliveryResult } from "./telegram-service";

/** Node Telegram 适配器在一次逻辑投递开始时取得出站快照，分页中途不能切换代理出口。 */
export class ProxyTelegramService {
  public constructor(private readonly configuration: Omit<TelegramConfiguration, "fetcher">, private readonly outbound: Pick<OutboundNetwork, "snapshot">) {}
  /** TelegramService 只接收受控 send 函数，不读取数据库、代理设置或任何凭据来源。 */
  public async send(messages: TelegramMessage[]): Promise<TelegramDeliveryResult[]> {
    const session = await this.outbound.snapshot();
    return new TelegramService({ ...this.configuration, fetcher: session.send.bind(session) }).send(messages);
  }
}
