import { resolve } from "node:path";

import { createPostgresDatabase } from "./database/pool";
import { readServerConfig } from "./config";
import { createPostgresServerDependencies } from "./dependencies";
import { startServer } from "./index";

/**
 * Node 进程入口只负责读取已校验配置、创建 PostgreSQL 连接边界和绑定退出信号；
 * 不把环境变量散落到业务服务，也不在启动日志输出连接串、Telegram 凭据或会话数据。
 */
const config = readServerConfig(process.env);
const database = createPostgresDatabase(config.databaseUrl);
const running = await startServer(config, createPostgresServerDependencies(database, config));
const shutdown = async () => {
  await running.close();
  await database.close();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

// 仅输出监听端口和构建目录，便于 NAS 健康诊断；任何秘密都不进入普通日志。
console.log(`switch-price-monitor listening on ${running.address().port}, static=${resolve(config.staticDirectory)}`);
