/**
 * 测试环境的最小 D1 绑定声明。只公开测试所需的数据库，
 * 防止测试误以为可以获得生产 Telegram、会话或其他运行时秘密。
 */
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
  }
}
