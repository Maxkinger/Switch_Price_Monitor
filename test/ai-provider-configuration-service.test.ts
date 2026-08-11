import { describe, expect, it } from "vitest";
import type { AiProviderConfigurationStore, EncryptedAiProviderConfiguration } from "../src/repositories/ports";
import { AiProviderConfigurationService } from "../src/services/ai-provider-configuration-service";

/**
 * 内存替身只保存服务已经加密后的载荷，模拟数据库单例而不复现 SQL；测试由此直接验证服务不会把 API Key、模型或地址以明文交给存储边界。
 * clone 会隔离调用方随后对 Uint8Array 的修改，避免测试替身因共享引用把 nonce 或密文篡改误归因为 AES-GCM 实现。
 */
class InMemoryAiProviderConfigurationStore implements AiProviderConfigurationStore {
  private value: EncryptedAiProviderConfiguration | null = null;

  public async getEncrypted(): Promise<EncryptedAiProviderConfiguration | null> {
    return this.value === null ? null : cloneEncrypted(this.value);
  }

  public async saveEncrypted(value: EncryptedAiProviderConfiguration): Promise<void> {
    this.value = cloneEncrypted(value);
  }

  public async clear(): Promise<void> {
    this.value = null;
  }
}

/** 公开固定夹具只覆盖配置结构，不是可用于任何供应商账户的真实凭据。 */
function validInput(apiKey = "test-api-key"): { apiKey: string; model: string; apiBaseUrl: "https://api.deepseek.com" } {
  return { apiKey, model: "deepseek-v4-flash", apiBaseUrl: "https://api.deepseek.com" };
}

/**
 * 测试主密钥固定为 32 个公开字节，仅为了使 AES-256-GCM 的长度合同可重复验证；生产主密钥不得来自源码、测试夹具或版本控制。
 */
const masterKeyBytes = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));

/**
 * 每次调用递增首字节的受控随机源，使断言能证明 save 重新请求随机 nonce；它不是加密安全随机源，生产默认值必须使用 crypto.randomBytes。
 */
function deterministicRandom(size: number): Uint8Array {
  deterministicRandom.calls += 1;
  return new Uint8Array(Array.from({ length: size }, (_, index) => deterministicRandom.calls + index));
}
deterministicRandom.calls = 0;

/** 克隆二进制字段以模拟 PostgreSQL bytea 的值语义，防止测试的读取操作反向改变存储状态。 */
function cloneEncrypted(value: EncryptedAiProviderConfiguration): EncryptedAiProviderConfiguration {
  return {
    algorithmVersion: value.algorithmVersion,
    nonce: new Uint8Array(value.nonce),
    ciphertext: new Uint8Array(value.ciphertext),
    updatedAt: value.updatedAt,
  };
}

describe("AI 供应商加密配置服务", () => {
  it("每次保存使用不同 nonce，数据库值不含 Key、模型或地址明文", async () => {
    // 若实现复用 nonce、跳过加密或仅加密 Key，本例会分别在 nonce、三项明文和最终解密断言处失败。
    deterministicRandom.calls = 0;
    const store = new InMemoryAiProviderConfigurationStore();
    const service = new AiProviderConfigurationService(store, masterKeyBytes, deterministicRandom);
    await service.save(validInput("first-public-test-key"), "2026-08-11T00:00:00.000Z");
    const first = await store.getEncrypted();
    await service.save(validInput("second-public-test-key"), "2026-08-11T00:01:00.000Z");
    const second = await store.getEncrypted();

    const persistedText = new TextDecoder().decode(second!.ciphertext);
    expect(persistedText).not.toContain("second-public-test-key");
    expect(persistedText).not.toContain("deepseek-v4-flash");
    expect(persistedText).not.toContain("https://api.deepseek.com");
    expect([...second!.nonce]).not.toEqual([...first!.nonce]);
    await expect(service.getCredentials()).resolves.toEqual(validInput("second-public-test-key"));
  });

  it("篡改密文、未知版本或缺失主密钥只返回未配置摘要", async () => {
    // 认证标签错误、版本轮换未知及运行环境漏配主密钥必须分别降级，不能因为其中一个短路而遗漏其他安全边界。
    deterministicRandom.calls = 0;
    const store = new InMemoryAiProviderConfigurationStore();
    const configuredService = new AiProviderConfigurationService(store, masterKeyBytes, deterministicRandom);
    await configuredService.save(validInput(), "2026-08-11T00:00:00.000Z");
    const encrypted = (await store.getEncrypted())!;

    const tamperedCiphertext = new Uint8Array(encrypted.ciphertext);
    tamperedCiphertext[tamperedCiphertext.length - 1] ^= 1;
    await store.saveEncrypted({ ...encrypted, ciphertext: tamperedCiphertext });
    await expect(configuredService.getSummary()).resolves.toEqual({ configured: false, model: null, apiBaseUrl: null });
    await expect(configuredService.getCredentials()).resolves.toBeNull();

    await store.saveEncrypted({ ...encrypted, algorithmVersion: 2 as 1 });
    await expect(configuredService.getSummary()).resolves.toEqual({ configured: false, model: null, apiBaseUrl: null });
    await expect(configuredService.getCredentials()).resolves.toBeNull();

    await store.saveEncrypted(encrypted);
    const missingKeyService = new AiProviderConfigurationService(store, undefined);
    await expect(missingKeyService.getSummary()).resolves.toEqual({ configured: false, model: null, apiBaseUrl: null });
    await expect(missingKeyService.getCredentials()).resolves.toBeNull();
  });

  it("保存前后都拒绝控制字符和非官方地址，避免旧密文绕过当前网络发送边界", async () => {
    // 删除任一输入校验或解密后复验都会使非法内容到达摘要/凭据，从而允许 Key 被发送到非官方目标或混入控制字符。
    const store = new InMemoryAiProviderConfigurationStore();
    const service = new AiProviderConfigurationService(store, masterKeyBytes, deterministicRandom);
    await expect(service.save({ ...validInput(), apiKey: "bad\u0000key" }, "2026-08-11T00:00:00.000Z")).rejects.toThrow();
    await expect(service.save({ ...validInput(), apiBaseUrl: "https://api.deepseek.com/" as "https://api.deepseek.com" }, "2026-08-11T00:00:00.000Z")).rejects.toThrow();
  });
});
