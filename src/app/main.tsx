/** 浏览器入口只负责挂载 React；价格采集、汇率与 Telegram 均不得在此客户端代码中运行。 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  // 根节点缺失代表 HTML 外壳损坏，立即失败比静默渲染空白页更便于部署排查。
  throw new Error("未找到应用根节点。");
}

// StrictMode 在开发环境主动暴露副作用问题，避免采集或通知逻辑被意外重复执行。
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
