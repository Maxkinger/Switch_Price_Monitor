import { resolve } from "node:path";

import { createPostgresDatabase } from "./database/pool";
import { runMigrations } from "./database/migrations";
import { readServerConfig } from "./config";
import { createPostgresSchedulerDependencies, createPostgresServerDependencies } from "./dependencies";
import { startServer } from "./index";
import { startScheduler } from "./scheduler";

/**
 * Node 进程入口只负责读取已校验配置、创建 PostgreSQL 连接边界和绑定退出信号；
 * 不把环境变量散落到业务服务，也不在启动日志输出连接串、Telegram 凭据或会话数据。
 */
const config = readServerConfig(process.env);
const database = createPostgresDatabase(config.databaseUrl);
// 数据库迁移在任何 HTTP 或定时业务启动前完成；目录可由容器启动配置覆盖，但不记录其外的环境变量或连接串。
await runMigrations(database, resolve(process.env.MIGRATIONS_DIRECTORY ?? "migrations/postgres"));
const running = await startServer(config, createPostgresServerDependencies(database, config));
const scheduler = startScheduler(createPostgresSchedulerDependencies(database, config));
const shutdown = async () => {
  // 先阻止新 Cron 触发，再停止 HTTP；已开始的任务和请求共享同一优雅期限，随后才释放 PostgreSQL 连接池。
  scheduler.stop();
  await running.close();
  await scheduler.waitForIdle(config.shutdownGraceMs);
  await database.close();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

// 仅输出监听端口和构建目录，便于 NAS 健康诊断；任何秘密都不进入普通日志。
console.log(`switch-price-monitor listening on ${running.address().port}, static=${resolve(config.staticDirectory)}`);
