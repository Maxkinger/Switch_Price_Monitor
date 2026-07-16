/**
 * 汇率接口只重导出跨来源通用契约，具体服务将在供应商验证后以同样的超时和回退方式接入。
 * 独立模块让价格采集器依赖稳定领域接口，而不是绑定某个可能更换的汇率网站。
 */
export type { ExchangeRateProvider, RateResult } from "./types";
