/**
 * React 管理端的根组件。认证界面接入前只呈现无敏感数据的初始化占位，
 * 防止未取得管理员会话时闪现价格、Telegram 或订阅配置。
 */
export function App() {
  // 这里是初始化占位界面；后续认证状态完成后将由页面路由替换，避免在未认证时展示价格数据。
  return <main className="app-shell">正在初始化价格监控站…</main>;
}
