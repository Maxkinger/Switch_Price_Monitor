import { PostgresSettingsRepository } from "../repositories/postgres/settings-repository";
import type { AppDatabase } from "./database/types";

/**
 * 在迁移完成后按显式配置补齐本机开发所需的公开设置单例。
 * false 分支绝不读取或改写业务记录，确保 NAS、生产和遗漏开关的进程继续走真实首次初始化；
 * true 分支也不建立管理员凭据、恢复码或会话，免登录只存在于本机开发进程的内存访问策略中。
 */
export async function ensureLocalDevelopmentSetup(
  database: AppDatabase,
  localDevelopmentAuthBypass: boolean,
  createdAt: string,
): Promise<void> {
  if (!localDevelopmentAuthBypass) return;
  await new PostgresSettingsRepository(database).ensureLocalDevelopmentDefaults(createdAt);
}
