import type { OfficialProductCandidate } from "../../shared/domain";
import { convertHongKongTraditionalToSimplified } from "../../shared/traditional-to-simplified";
import type { OfficialMainlandNintendoProductPageResolver } from "../providers/official-mainland-nintendo-product-page";
import type { OfficialProductDiscoveryService } from "./official-product-discovery-service";

/**
 * 官方中文名称解析结果只表达可核验来源与最终显示文字；候选、页面正文和匹配分数不会暴露给 API 或持久化层。
 * unavailable 要求上层保留人工中文/官方英文回退，禁止把任意标题误标成官方中文。
 */
export type OfficialGameNameResolution =
  | { kind: "mainland_official" | "hong_kong_official"; nameZh: string }
  | { kind: "unavailable" };

/** 名称服务只依赖发现服务的窄候选能力，不能借用搜索详情、设置或订阅写入扩大职责。 */
type HongKongCandidateResolver = Pick<OfficialProductDiscoveryService, "resolveUniqueHongKongCandidate">;

/**
 * 从唯一香港官方候选决定显示名来源。大陆标题必须由 `titles/{ID}` 到 `software/{同一 ID}` 精确对应；
 * 香港 canonicalTitle 仅在候选身份已经独立核验后用于显示和离线繁转简，转换结果及锚点标题都不得反向参与身份判断。
 */
export class GameNameService {
  public constructor(
    private readonly discovery: HongKongCandidateResolver,
    private readonly mainland: OfficialMainlandNintendoProductPageResolver,
  ) {}

  /**
   * 优先返回大陆同 ID 官方标题；没有精确 titles ID 或大陆页面不可用时才转换已核验香港标题。
   * 任一转换异常都降级 unavailable，避免空值、异常文本或猜测名称自动覆盖现有游戏名。
   */
  public async resolveOfficialName(
    anchor: OfficialProductCandidate,
    knownHongKongUrl?: string,
  ): Promise<OfficialGameNameResolution> {
    const candidate = await this.discovery.resolveUniqueHongKongCandidate(anchor, knownHongKongUrl);
    if (candidate === null) return { kind: "unavailable" };

    const hongKongTitleId = readHongKongTitleId(candidate.productUrl);
    if (hongKongTitleId !== null) {
      const mainlandTitle = await this.mainland.resolve(hongKongTitleId);
      if (mainlandTitle !== null) return { kind: "mainland_official", nameZh: mainlandTitle };
    }

    try {
      return {
        kind: "hong_kong_official",
        nameZh: convertHongKongTraditionalToSimplified(candidate.canonicalTitle),
      };
    } catch {
      return { kind: "unavailable" };
    }
  }
}

/**
 * 只从 `ec.nintendo.com/HK/zh/titles/{纯数字 ID}` 的完整无参数 URL 读取大陆映射 ID。
 * aocs、bundles、查询参数、片段、非 HTTPS 或其他主机均返回 null，绝不按标题文字推断或搜索大陆商品。
 */
function readHongKongTitleId(productUrl: string): string | null {
  try {
    const url = new URL(productUrl);
    return url.origin === "https://ec.nintendo.com"
      && url.username === ""
      && url.password === ""
      && url.search === ""
      && url.hash === ""
      ? /^\/HK\/zh\/titles\/(\d+)$/u.exec(url.pathname)?.[1] ?? null
      : null;
  } catch {
    return null;
  }
}
