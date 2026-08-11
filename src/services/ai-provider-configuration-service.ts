import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type {
  AiProviderConfigurationStore,
  AiProviderConfigurationSummary,
  AiProviderCredentials,
  EncryptedAiProviderConfiguration,
} from "../repositories/ports";

const ALGORITHM_VERSION = 1 as const;
const AES_256_GCM_NONCE_LENGTH = 12;
const AES_GCM_TAG_LENGTH = 16;
const AES_256_KEY_LENGTH = 32;
const MAXIMUM_API_KEY_LENGTH = 512;
const MAXIMUM_MODEL_LENGTH = 128;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/u;
const OFFICIAL_DEEPSEEK_API_BASE_URL = "https://api.deepseek.com" as const;

/** 注入随机字节源仅用于测试重现 nonce；默认值使用 Node crypto.randomBytes，调用方不得以可预测实现替代生产随机性。 */
export type RandomBytes = (size: number) => Uint8Array;

/**
 * 动态外部调用只需要这个只读窄接口；它避免 DeepSeek 适配器取得保存、清除或数据库密文能力，
 * 也确保凭据只在单次请求的短暂内存生命周期内出现。
 */
export interface AiProviderConfigurationReader {
  getCredentials(): Promise<AiProviderCredentials | null>;
}

/**
 * AI 供应商配置服务拥有凭据的唯一明文生命周期：先校验、再 AES-256-GCM 加密，读取时认证解密并再次校验。
 * 所有解密失败均降级为 null，防止篡改密文、旧版本、错误主密钥或 crypto 细节传到路由、日志或浏览器。
 */
export class AiProviderConfigurationService {
  public constructor(
    private readonly store: AiProviderConfigurationStore,
    private readonly masterKey?: Uint8Array,
    private readonly random: RandomBytes = randomBytes,
  ) {}

  /**
   * 返回严格不含 Key 的摘要；仅成功认证并通过当前字段规则的旧密文才可视为已配置，避免数据库内容被手工篡改后误导管理员页面。
   */
  public async getSummary(): Promise<AiProviderConfigurationSummary> {
    const credentials = await this.getCredentials();
    return credentials === null
      ? { configured: false, model: null, apiBaseUrl: null }
      : { configured: true, model: credentials.model, apiBaseUrl: credentials.apiBaseUrl };
  }

  /**
   * 完整验证后使用每次新生的 12 字节 nonce 加密 JSON 载荷，并把 16 字节 GCM 认证标签追加到密文末尾。
   * 主密钥缺失或不是 32 字节时拒绝写入，而不是写明文或不可恢复的伪密文；调用 API 层会将此映射为固定安全错误。
   */
  public async save(input: AiProviderCredentials, updatedAt: string): Promise<void> {
    const credentials = validateCredentials(input);
    const masterKey = requireMasterKey(this.masterKey);
    const nonce = this.random(AES_256_GCM_NONCE_LENGTH);
    if (nonce.byteLength !== AES_256_GCM_NONCE_LENGTH) throw new Error("AI 配置随机 nonce 无效。");
    const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(credentials), "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    await this.store.saveEncrypted({
      algorithmVersion: ALGORITHM_VERSION,
      nonce: new Uint8Array(nonce),
      ciphertext: new Uint8Array(ciphertext),
      updatedAt,
    });
  }

  /** 清除密文单例不需要也不读取主密钥，使管理员可在主密钥丢失或轮换后安全移除不可解密的旧配置。 */
  public async clear(): Promise<void> {
    await this.store.clear();
  }

  /**
   * 获取仅供内存中一次 DeepSeek 请求使用的已认证凭据。所有存储、JSON、版本、长度、认证标签或密钥错误都被统一捕获为 null，
   * 既不泄漏失败原因，也不允许旧密文绕过当前官方地址与控制字符规则。
   */
  public async getCredentials(): Promise<AiProviderCredentials | null> {
    try {
      const encrypted = await this.store.getEncrypted();
      const masterKey = this.masterKey;
      if (encrypted === null || !isValidMasterKey(masterKey) || !isDecryptableEnvelope(encrypted)) return null;
      const ciphertext = Buffer.from(encrypted.ciphertext);
      const encryptedPayload = ciphertext.subarray(0, -AES_GCM_TAG_LENGTH);
      const authTag = ciphertext.subarray(-AES_GCM_TAG_LENGTH);
      const decipher = createDecipheriv("aes-256-gcm", masterKey, encrypted.nonce);
      decipher.setAuthTag(authTag);
      const plaintext = Buffer.concat([decipher.update(encryptedPayload), decipher.final()]).toString("utf8");
      return validateCredentials(JSON.parse(plaintext) as unknown);
    } catch {
      return null;
    }
  }
}

/** AES-256-GCM 只接受恰好 32 字节主密钥；拒绝短/长值可防止 crypto 隐式报错细节进入读取或写入业务流。 */
function isValidMasterKey(value: Uint8Array | undefined): value is Uint8Array {
  return value instanceof Uint8Array && value.byteLength === AES_256_KEY_LENGTH;
}

/** 写入错误保持固定中文摘要，调用方无需分辨环境漏配与非法输入，且不会得到任何加密内部状态。 */
function requireMasterKey(value: Uint8Array | undefined): Uint8Array {
  if (!isValidMasterKey(value)) throw new Error("AI 加密主密钥不可用。");
  return value;
}

/** 密文结构先于 crypto 调用验证，避免未知版本、错误 nonce 或没有认证标签的数据库内容触发底层异常。 */
function isDecryptableEnvelope(value: EncryptedAiProviderConfiguration): boolean {
  return value.algorithmVersion === ALGORITHM_VERSION
    && value.nonce instanceof Uint8Array
    && value.nonce.byteLength === AES_256_GCM_NONCE_LENGTH
    && value.ciphertext instanceof Uint8Array
    && value.ciphertext.byteLength > AES_GCM_TAG_LENGTH;
}

/**
 * 统一校验输入及解密 JSON，确保 API 请求、旧密文和未来导入都执行完全相同的官方地址、长度和控制字符限制。
 * API Key 不 trim，避免静默修改供应商签名材料；模型允许 trim 后保存规范值，地址必须是无路径、无端口且精确相等的官方 origin。
 */
function validateCredentials(value: unknown): AiProviderCredentials {
  if (!isRecord(value) || typeof value.apiKey !== "string" || typeof value.model !== "string" || typeof value.apiBaseUrl !== "string") {
    throw new Error("AI 配置无效。");
  }
  const model = value.model.trim();
  if (
    value.apiKey.length === 0
    || value.apiKey.length > MAXIMUM_API_KEY_LENGTH
    || CONTROL_CHARACTER.test(value.apiKey)
    || model.length === 0
    || model.length > MAXIMUM_MODEL_LENGTH
    || CONTROL_CHARACTER.test(model)
    || value.apiBaseUrl !== OFFICIAL_DEEPSEEK_API_BASE_URL
  ) {
    throw new Error("AI 配置无效。");
  }
  return { apiKey: value.apiKey, model, apiBaseUrl: OFFICIAL_DEEPSEEK_API_BASE_URL };
}

/** JSON 解析后的 unknown 只能在确认非 null 对象后读取字段，避免原型、数组或标量在解密成功后进入请求边界。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
