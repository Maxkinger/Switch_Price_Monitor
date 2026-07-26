/**
 * 腾讯 Nintendo Switch 大陆商品页提供方只接收已经从香港官方 `titles/{数字 ID}` 提取的 ID。
 * 返回值仅包含非空页面标题；HTML 正文、外部错误和重定向细节都不会越过该接口进入服务或浏览器。
 */
export interface OfficialMainlandNintendoProductPageResolver {
  resolve(hongKongTitleId: string | null): Promise<string | null>;
}

/** 大陆官方软件页的固定来源；调用方不能覆盖主机或路径，避免把只读名称能力扩大为任意网络请求代理。 */
const mainlandSoftwareOrigin = "https://www.nintendoswitch.com.cn";

/**
 * 创建受限大陆官方商品页解析器。请求前验证十进制 ID，请求后再次验证最终 URL 仍为同一 ID 的精确软件路径；
 * HTTP、网络、重定向或标题结构异常均返回 null，让上层安全回退香港官方名称而不是猜测大陆译名。
 */
export function createOfficialMainlandNintendoProductPageResolver(
  fetchPage: typeof fetch = fetch,
): OfficialMainlandNintendoProductPageResolver {
  return {
    async resolve(hongKongTitleId) {
      if (hongKongTitleId === null || !/^\d+$/.test(hongKongTitleId)) return null;
      const expectedPath = `/software/${hongKongTitleId}`;
      const requestUrl = `${mainlandSoftwareOrigin}${expectedPath}`;

      let response: Response;
      try {
        // 请求不携带 Cookie、账号或购买状态；公开标题足以完成显示名核验，最小请求面也避免泄漏管理员身份。
        response = await fetchPage(requestUrl, {
          headers: { accept: "text/html,application/xhtml+xml" },
        });
      } catch {
        // 外部网络错误只代表大陆来源本次不可用；不得把错误对象或上游细节返回给名称同步/API。
        return null;
      }
      if (response.redirected || !response.ok || !isExactMainlandSoftwareResponse(response.url, expectedPath)) return null;

      let html: string;
      try {
        html = await response.text();
      } catch {
        return null;
      }
      return readNonEmptyDocumentTitle(html);
    },
  };
}

/**
 * fetch 可能自动跟随 3xx，因此核验 Response 最终 URL 而非仅核验请求地址。
 * 主机、协议、精确路径、查询参数和片段必须全部一致，任何跳转都不能借另一页标题证明同一香港商品 ID。
 */
function isExactMainlandSoftwareResponse(responseUrl: string, expectedPath: string): boolean {
  try {
    const url = new URL(responseUrl);
    return url.origin === mainlandSoftwareOrigin
      && url.username === ""
      && url.password === ""
      && url.pathname === expectedPath
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

/**
 * 只读取 HTML 文档的首个非空 title，并做有限实体还原；正文不会被记录、返回或用于标题搜索。
 * 实体处理只恢复页面标题的字面展示，不参与商品身份判断，也不会把缺失标题替换成 URL、ID 或锚点名称。
 */
function readNonEmptyDocumentTitle(html: string): string | null {
  const rawTitle = /<title\b[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1];
  if (rawTitle === undefined) return null;
  const title = decodeHtmlTitleEntities(rawTitle.replace(/<[^>]*>/gu, "")).replace(/\s+/gu, " ").trim();
  return title.length > 0 ? title : null;
}

/**
 * title 元素只需支持标准数字实体和五个 XML/HTML 基础命名实体；未知实体保持原样，
 * 避免引入宽泛 HTML 解析或把正文节点误拼入可保存的游戏名称。
 */
function decodeHtmlTitleEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/giu, (_match, digits: string) => decodeCodePoint(digits, 16))
    .replace(/&#([0-9]+);/gu, (_match, digits: string) => decodeCodePoint(digits, 10))
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;|&apos;/giu, "'");
}

/** 非法或超出 Unicode 范围的数字实体保持原字符串，防止解析异常把整个有效官方标题降级。 */
function decodeCodePoint(digits: string, radix: number): string {
  const codePoint = Number.parseInt(digits, radix);
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return radix === 16 ? `&#x${digits};` : `&#${digits};`;
  }
}
