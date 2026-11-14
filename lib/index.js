/**
 * 划词助手 —— 宿主（Node）侧入口。
 *
 * 浏览器侧（`lib/client.js`）负责左栏入口、划词浮条与划词本面板；这里提供它需要的
 * 两套宿主能力，都注册在 client-connection 的 `/api` 通道上（浏览器认证与
 * Host/Origin 校验由该通道统一负责）：
 *
 *   1. `./host/lookup.js` —— `/api/wordhelper/health` 与 `/api/wordhelper/lookup`：
 *      用宿主当前的默认模型做翻译 / 解释。
 *   2. `./host/desktop.js` —— `/api/wordhelper/desktop`：全电脑的剪贴板监听与
 *      模拟输入（模拟 Ctrl+V），让划词助手跳出 DSH 页面。
 *
 * 两个模块都延迟加载并各自兜底：任何一个出问题都不影响另一套能力，也不影响
 * 浏览器侧界面照常加载。
 */

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主上下文。
 * @returns {Promise<() => void>} 释放函数。
 */
async function apply(ctx) {
  /** @type {Array<() => void | Promise<void>>} */
  const disposers = [];

  try {
    const { registerLookupRoutes } = await import("./host/lookup.js");
    const dispose = registerLookupRoutes(ctx);
    disposers.push(typeof dispose === "function" ? dispose : () => {});
  } catch (error) {
    warn(ctx, "查询路由未启用", error);
  }

  try {
    const { createDesktopBridge, registerDesktopRoutes } = await import("./host/desktop.js");
    const bridge = createDesktopBridge(ctx);
    const disposeRoutes = registerDesktopRoutes(ctx, bridge);
    disposers.push(disposeRoutes);
    disposers.push(() => bridge.dispose());
    // 用户在面板里打开过监听的话，宿主重启后自动接着听；没打开就不碰剪贴板。
    bridge.restore().catch((error) => warn(ctx, "恢复桌面监听失败", error));
  } catch (error) {
    warn(ctx, "桌面联动未启用", error);
  }

  return async () => {
    for (const dispose of disposers.reverse()) {
      try {
        await dispose();
      } catch (error) {
        warn(ctx, "释放失败", error);
      }
    }
  };
}

function warn(ctx, message, error) {
  const detail = error && error.message ? error.message : String(error);
  ctx.logger?.warn?.(`dsh-wordhelper: ${message}：${detail}`);
}

/** 需要带浏览器认证的 `/api` 通道；缺了它界面仍可用，只是没有翻译/解释与桌面联动。 */
const inject = ["connection"];

export { apply, inject };
