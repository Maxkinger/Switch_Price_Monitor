import packageManifest from "../../package.json";

/**
 * 发布版本只在 Vite 构建时从根包清单读取一次，避免浏览器请求文件系统或维护会与部署版本漂移的第二份字符串。
 * 该值仅供管理员核对页面发布批次，绝不用于认证、价格、D1 迁移或任何安全决策。
 */
export const releaseVersion: string = packageManifest.version;
