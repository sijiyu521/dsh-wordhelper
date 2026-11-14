/**
 * 划词助手 —— 桌面联动（Windows）。
 *
 * 浏览器里的划词浮条只能管 DSH 页面内部。这个模块把「划词」延伸到整个电脑：
 *
 *   1. **全局剪贴板监听**：常驻一个隐藏的 PowerShell 子进程，每 ~420ms 读一次
 *      系统剪贴板；文字一变就通过 stdout 报给宿主，带上是哪个前台窗口复制的。
 *      这样在任何程序里 Ctrl+C，划词本都能收到。
 *   2. **模拟输入**：把一段文字放进剪贴板，切换回上一个外部窗口，再模拟一次
 *      Ctrl+V，把它「打」进那个窗口里。切不过去就只放剪贴板、不发送按键。
 *
 * 全部通过 Windows 自带的 PowerShell 5.1 + Win32 API 完成，不依赖任何原生
 * 扩展，也不 import 任何 `@deepseek-ai/*` 包。监听默认关闭，由用户显式打开。
 *
 * @module dsh-wordhelper/lib/host/desktop
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PASTE_SCRIPT, WATCHER_SCRIPT } from "./scripts.js";

/** 桌面联动的查询 / 操作路由。 */
export const DESKTOP_PATH = "/api/wordhelper/desktop";

/** 最多保留多少条系统剪贴板捕获（只在内存里）。 */
const MAX_ITEMS = 40;

/** 单条文本上限，与查询路由保持一致。 */
const MAX_TEXT = 4000;

/** 前台窗口标题被认为是 DSH 自己时，不当作「外部窗口」。 */
const SELF_TITLE_HINTS = ["DeepSeek Harness", "DeepSeek", "dsh"];

/** 重启用退避表（毫秒）。 */
const RESTART_BACKOFF_MS = [800, 1500, 3000, 6000, 10000];

/** 粘贴脚本的超时。 */
const PASTE_TIMEOUT_MS = 15000;

/** 我们自己写进剪贴板的文字，在这么久之内被监听读到就不当成一次用户复制。 */
const ECHO_WINDOW_MS = 8000;

/** 解析 PowerShell 可执行文件；非 Windows 返回 null。 */
function resolvePowerShell() {
  if (process.platform !== "win32") return null;
  const root = process.env.SystemRoot ?? "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function base64Decode(value) {
  try {
    return Buffer.from(String(value), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function base64Encode(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

/** 判断标题是不是 DSH 自己（避免把「打回窗口」打到 DSH 上）。 */
function isSelfWindow(title) {
  const value = String(title ?? "");
  return SELF_TITLE_HINTS.some((hint) => value.includes(hint));
}

/** 状态文件目录：跟随 DSH_HOME，缺省回落到 ~/.dsh。 */
function stateFile() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  return path.join(home, "wordhelper", "desktop.json");
}

/**
 * 创建桌面联动桥接。宿主持有一个实例，路由与监听子进程都挂在它上面。
 * @param {object} ctx - 宿主插件上下文（只用 `logger`）。
 * @param {{ powershell?: string | null, pollIntervalMs?: number }} [options]
 * @returns {object} 桥接对象。
 */
export function createDesktopBridge(ctx, options = {}) {
  const powershell = options.powershell === undefined ? resolvePowerShell() : options.powershell;
  const available = typeof powershell === "string" && powershell !== "";
  ctx.logger?.info?.(`dsh-wordhelper: 桌面联动已就绪（模拟输入${available ? "可用" : "不可用"}，监听默认关闭）`);

  let enabled = false;
  let child = null;
  let reader = null;
  let disposed = false;
  let restartTimer = 0;
  let restartAttempt = 0;
  let ready = false;
  let lastError = null;
  let startedAt = 0;
  let sequence = 0;
  let items = [];
  let focus = { hwnd: 0, title: null };
  let lastExternal = { hwnd: 0, title: null };
  /** 自己刚写进剪贴板的文字，读到就吞掉，别当成用户复制。 */
  let echo = null;

  function log(level, message, error) {
    const text = error === undefined ? message : `${message}：${String(error && error.message ? error.message : error)}`;
    if (level === "warn") ctx.logger?.warn?.(`dsh-wordhelper: ${text}`);
    else ctx.logger?.info?.(`dsh-wordhelper: ${text}`);
  }

  // #region 状态持久化（只存开关，不存内容）

  let persistChain = Promise.resolve();

  function persistEnabled() {
    const file = stateFile();
    const payload = JSON.stringify({ enabled }, null, 2);
    persistChain = persistChain
      .then(async () => {
        await mkdir(path.dirname(file), { recursive: true });
        const temporary = `${file}.tmp`;
        await writeFile(temporary, payload, "utf8");
        await rename(temporary, file);
      })
      .catch((error) => log("warn", "保存桌面开关失败", error));
    return persistChain;
  }

  async function restoreEnabled() {
    try {
      const raw = await readFile(stateFile(), "utf8");
      const parsed = JSON.parse(raw);
      return parsed !== null && typeof parsed === "object" && parsed.enabled === true;
    } catch {
      return false;
    }
  }

  // #endregion

  // #region 监听子进程

  function handleLine(line) {
    if (process.env.DSH_WORDHELPER_DEBUG === "1") {
      ctx.logger?.info?.(`dsh-wordhelper: [watch] ${String(line).slice(0, 120)}`);
    }
    if (line === "READY") {
      ready = true;
      lastError = null;
      startedAt = Date.now();
      restartAttempt = 0;
      log("info", "桌面剪贴板监听已启动");
      return;
    }
    const separator = line.indexOf("|");
    if (separator < 0) return;
    const kind = line.slice(0, separator);
    const rest = line.slice(separator + 1);
    if (kind === "FOCUS") {
      const parts = rest.split("|");
      const title = base64Decode(parts[1]);
      const hwnd = Number.parseInt(parts[0], 10);
      focus = { hwnd: Number.isFinite(hwnd) ? hwnd : 0, title: title };
      if (title !== "" && isSelfWindow(title) === false) lastExternal = focus;
      return;
    }
    if (kind === "CLIP") {
      const parts = rest.split("|");
      const text = base64Decode(parts[0]).trim().slice(0, MAX_TEXT);
      const app = base64Decode(parts[1]) || "剪贴板";
      if (text === "") return;
      if (echo !== null && echo.text === text && Date.now() - echo.at < ECHO_WINDOW_MS) {
        echo = null;
        return;
      }
      echo = null;
      const newest = items[0];
      if (newest !== undefined && newest.text === text) return;
      sequence += 1;
      items = [{ id: `d_${Date.now().toString(36)}_${sequence}`, text, app, at: Date.now() }].concat(items).slice(0, MAX_ITEMS);
      return;
    }
    if (kind === "ERR") {
      lastError = base64Decode(rest) || "监听进程报错";
      log("warn", "剪贴板监听报错", new Error(lastError));
    }
  }

  function start() {
    if (disposed || available !== true || child !== null) return;
    ready = false;
    lastError = null;
    const spawned = spawn(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-Command", WATCHER_SCRIPT], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child = spawned;
    spawned.on("error", (error) => {
      lastError = String(error && error.message ? error.message : error);
      log("warn", "无法启动剪贴板监听", error);
      child = null;
      scheduleRestart();
    });
    spawned.on("exit", (code) => {
      if (reader !== null) {
        reader.close();
        reader = null;
      }
      if (child === spawned) child = null;
      ready = false;
      if (disposed || enabled !== true) return;
      lastError = `监听进程已退出（code ${code ?? "null"}）`;
      log("warn", lastError);
      scheduleRestart();
    });
    spawned.stderr?.setEncoding("utf8");
    spawned.stderr?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text !== "") lastError = text.slice(0, 300);
    });
    if (spawned.stdout !== null) {
      spawned.stdout.setEncoding("utf8");
      reader = createInterface({ input: spawned.stdout });
      reader.on("line", handleLine);
    }
  }

  function stop() {
    if (restartTimer !== 0) {
      clearTimeout(restartTimer);
      restartTimer = 0;
    }
    if (reader !== null) {
      reader.close();
      reader = null;
    }
    if (child !== null) {
      const doomed = child;
      child = null;
      try {
        doomed.kill();
      } catch {
        // 已经退出就算了。
      }
    }
    ready = false;
  }

  function scheduleRestart() {
    if (disposed || enabled !== true) return;
    if (restartTimer !== 0) return;
    const delay = RESTART_BACKOFF_MS[Math.min(restartAttempt, RESTART_BACKOFF_MS.length - 1)];
    restartAttempt += 1;
    restartTimer = setTimeout(() => {
      restartTimer = 0;
      start();
    }, delay);
  }

  async function setEnabled(next) {
    const value = next === true;
    if (value === enabled) return enabled;
    enabled = value;
    if (value) {
      restartAttempt = 0;
      start();
    } else {
      stop();
    }
    await persistEnabled();
    return enabled;
  }

  // #endregion

  // #region 模拟输入

  /**
   * 把文字写进剪贴板，并按需模拟一次 Ctrl+V。
   *
   * `target: "previous"` 会切回监听记住的上一个外部窗口；没记住就不发送按键，
   * 只把文字放进剪贴板（免得 Ctrl+V 打进 DSH 自己）。
   * @param {string} text - 要「打」出去的文字。
   * @param {{ target?: "previous" | "current", delayMs?: number }} [options]
   * @returns {Promise<{ ok: boolean, code?: string, message?: string, typed?: boolean, clipboard?: boolean, target?: object | null }>}
   */
  async function paste(text, options = {}) {
    if (available !== true) return { ok: false, code: "unsupported", message: "当前系统不支持模拟输入" };
    const value = String(text ?? "").trim();
    if (value === "") return { ok: false, code: "empty-text", message: "没有可输入的文字" };
    const target = options.target === "current" ? "current" : "previous";
    const delayMs = Number.isFinite(options.delayMs) ? Math.max(0, Math.min(5000, Math.floor(options.delayMs))) : 0;
    const hwnd = target === "previous" && lastExternal.hwnd > 0 ? lastExternal.hwnd : 0;
    const sendKeys = target === "current" || hwnd > 0;

    // 我们自己写进剪贴板的内容会被监听当成一次复制，先登记，读到就吞掉。
    echo = sendKeys || hwnd >= 0 ? { text: value, at: Date.now() } : null;

    const stdout = await runPasteScript(value, hwnd, delayMs, sendKeys);
    let parsed = null;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = null;
    }
    const targetInfo = target === "previous" && hwnd > 0 ? lastExternal : null;
    if (parsed === null) return { ok: false, code: "script", message: "模拟输入没有返回结果", clipboard: true, target: targetInfo };
    if (parsed.ok === true && parsed.typed === false) {
      return {
        ok: false,
        code: "no-target",
        message: "还没记住上一个窗口，文字已经放进剪贴板，手动 Ctrl+V 就行",
        typed: false,
        clipboard: true,
        target: null
      };
    }
    if (parsed.ok === true) return { ok: true, typed: true, clipboard: true, target: targetInfo };
    const reason = String(parsed.reason ?? "failed");
    const messages = {
      focus: "没能切回上一个窗口，文字已经放进剪贴板，手动 Ctrl+V 就行",
      clipboard: "写入剪贴板失败",
      sendkeys: "发送 Ctrl+V 失败，文字已放进剪贴板",
      assembly: "系统组件加载失败",
      failed: "模拟输入失败"
    };
    return {
      ok: false,
      code: reason,
      message: messages[reason] ?? "模拟输入失败",
      typed: false,
      clipboard: parsed.clipboard === true,
      target: targetInfo
    };
  }

  function runPasteScript(text, hwnd, delayMs, sendKeys) {
    return new Promise((resolve) => {
      let output = "";
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          // 忽略。
        }
        finish("");
      }, PASTE_TIMEOUT_MS);
      const proc = spawn(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-Command", PASTE_SCRIPT], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: Object.assign({}, process.env, {
          WH_TEXT_B64: base64Encode(text),
          WH_HWND: String(hwnd),
          WH_DELAY: String(delayMs),
          WH_SENDKEYS: sendKeys === true ? "1" : "0",
          WH_SELF_TITLE_B64: base64Encode(SELF_TITLE_HINTS[0])
        })
      });
      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk) => {
        output += String(chunk);
      });
      proc.on("error", () => {
        clearTimeout(timer);
        finish("");
      });
      proc.on("exit", () => {
        clearTimeout(timer);
        finish(output.trim());
      });
    });
  }

  // #endregion

  return {
    /** 当前能力与状态快照（供 `GET /api/wordhelper/desktop`）。 */
    getState() {
      return {
        ok: true,
        supported: available,
        platform: process.platform,
        enabled,
        running: child !== null && ready,
        error: lastError,
        startedAt: startedAt === 0 ? null : startedAt,
        focus: lastExternal.hwnd === 0 ? null : lastExternal,
        items: items.slice(),
        limit: MAX_ITEMS
      };
    },
    /** 从状态文件恢复「上次是否开启」，宿主启动时调用一次。 */
    async restore() {
      if (available !== true) return false;
      const wanted = await restoreEnabled();
      if (wanted === true) await setEnabled(true);
      return enabled;
    },
    setEnabled,
    paste,
    dispose() {
      disposed = true;
      enabled = false;
      stop();
    }
  };
}

/**
 * 注册桌面联动的 `/api` 路由。
 * @param {object} ctx - 宿主插件上下文（需要 `connection`）。
 * @param {ReturnType<typeof createDesktopBridge>} bridge - 桥接实例。
 * @returns {() => void} 释放函数。
 */
export function registerDesktopRoutes(ctx, bridge) {
  const connection = ctx?.connection;
  if (connection === null || connection === undefined || typeof connection.registerFetchRoute !== "function") {
    throw new Error("dsh-wordhelper: 桌面联动需要 client-connection 的 /api 通道");
  }

  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

  return connection.registerFetchRoute(ctx, {
    path: DESKTOP_PATH,
    methods,
    requestBody: "buffered",
    fetch: async (request) => {
      try {
        if (request.method === "GET") {
          return json(bridge.getState());
        }
        if (request.method !== "POST") {
          return new Response("method not allowed", { status: 405, headers: { allow: "GET, POST" } });
        }
        let body = null;
        try {
          body = await request.json();
        } catch {
          return json({ ok: false, code: "invalid-body", message: "请求体不是合法的 JSON" }, 400);
        }
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
          return json({ ok: false, code: "invalid-body", message: "请求参数无效" }, 400);
        }
        if (typeof body.enabled === "boolean") {
          await bridge.setEnabled(body.enabled);
          return json(bridge.getState());
        }
        if (body.action === "paste" || body.action === "copy") {
          const result = await bridge.paste(body.text, {
            target: body.target === "current" ? "current" : "previous",
            delayMs: body.delayMs
          });
          return json(result, result.ok === true ? 200 : 409);
        }
        return json({ ok: false, code: "invalid-action", message: "未知的桌面联动操作" }, 400);
      } catch (error) {
        ctx.logger?.warn?.(`dsh-wordhelper: 桌面联动路由失败：${String(error && error.message ? error.message : error)}`);
        return json({ ok: false, code: "internal", message: "桌面联动内部错误" }, 500);
      }
    }
  });
}
