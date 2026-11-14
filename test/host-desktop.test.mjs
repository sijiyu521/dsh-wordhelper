/**
 * 桌面联动路由层单测：只测 `/api/wordhelper/desktop` 的协议与分发，
 * 不真的去碰剪贴板或 PowerShell（那是 `.tmp/desktop-e2e.mjs` 的事）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import { DESKTOP_PATH, registerDesktopRoutes } from "../lib/host/desktop.js";

/** 造一个只记录路由的假 connection。 */
function createServer() {
  const routes = new Map();
  return {
    routes,
    connection: {
      registerFetchRoute(owner, route) {
        if (routes.has(route.path)) throw new Error(`duplicate ${route.path}`);
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      }
    }
  };
}

/** 造一期假状态 + 调用记录。 */
function createBridge(overrides = {}) {
  const calls = [];
  const state = {
    ok: true,
    supported: true,
    platform: "win32",
    enabled: false,
    running: false,
    error: null,
    startedAt: null,
    focus: null,
    items: []
  };
  return {
    calls,
    bridge: {
      getState: () => ({ ...state, ...overrides.state }),
      setEnabled: async (value) => {
        calls.push(["setEnabled", value]);
        state.enabled = value === true;
        state.running = value === true;
        return state.enabled;
      },
      paste: async (text, options) => {
        calls.push(["paste", text, options]);
        return { ok: true, typed: true, clipboard: true, target: { hwnd: 42, title: "记事本" } };
      },
      dispose() {}
    }
  };
}

function setup(overrides) {
  const { routes, connection } = createServer();
  const { calls, bridge } = createBridge(overrides);
  const ctx = { connection, logger: { info() {}, warn() {} } };
  const dispose = registerDesktopRoutes(ctx, bridge);
  const route = routes.get(DESKTOP_PATH);
  assert.ok(route, "应该注册 /api/wordhelper/desktop");
  return { route, calls, bridge, dispose, routes };
}

const json = (body) =>
  new Request("http://127.0.0.1/api/wordhelper/desktop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });

test("路由路径与方法表", () => {
  const { route } = setup();
  assert.equal(route.path, "/api/wordhelper/desktop");
  assert.equal(route.requestBody, "buffered");
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    assert.ok(route.methods.includes(method), `缺少方法 ${method}`);
  }
});

test("没有 connection 时明确报错", () => {
  assert.throws(() => registerDesktopRoutes({}, createBridge().bridge), /client-connection/);
  assert.throws(() => registerDesktopRoutes({ connection: {} }, createBridge().bridge), /client-connection/);
});

test("GET 返回状态快照与 JSON 头", async () => {
  const { route } = setup({ state: { supported: true, enabled: true, running: true } });
  const response = await route.fetch(new Request("http://127.0.0.1/api/wordhelper/desktop", { method: "GET" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.enabled, true);
  assert.equal(body.running, true);
  assert.equal(body.platform, "win32");
});

test("POST { enabled } 转给桥接并回最新状态", async () => {
  const { route, calls } = setup();
  const response = await route.fetch(json({ enabled: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0], ["setEnabled", true]);
  const body = await response.json();
  assert.equal(body.enabled, true);
});

test("POST { action: paste } 默认打回上一个窗口", async () => {
  const { route, calls } = setup();
  const response = await route.fetch(json({ action: "paste", text: " hello " }));
  assert.equal(response.status, 200);
  const [name, text, options] = calls[0];
  assert.equal(name, "paste");
  assert.equal(text, " hello ");
  assert.equal(options.target, "previous");
  const body = await response.json();
  assert.equal(body.typed, true);
});

test("POST { action: copy } 与 target/delay 透传", async () => {
  const { route, calls } = setup();
  await route.fetch(json({ action: "copy", text: "x", target: "current", delayMs: 1500 }));
  assert.deepEqual(calls[0], ["paste", "x", { target: "current", delayMs: 1500 }]);
});

test("未知操作 → 400", async () => {
  const { route } = setup();
  const response = await route.fetch(json({ action: "explode" }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "invalid-action");
});

test("坏 JSON → 400 invalid-body", async () => {
  const { route } = setup();
  const request = new Request("http://127.0.0.1/api/wordhelper/desktop", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{ 不是 json"
  });
  const response = await route.fetch(request);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid-body");
});

test("数组请求体 → 400", async () => {
  const { route } = setup();
  const response = await route.fetch(json([1, 2, 3]));
  assert.equal(response.status, 400);
});

test("非 GET/POST → 405 且带 allow 头", async () => {
  const { route } = setup();
  const response = await route.fetch(new Request("http://127.0.0.1/api/wordhelper/desktop", { method: "PUT" }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, POST");
});

test("桥接抛错 → 500 且不泄漏内部信息", async () => {
  const { routes, connection } = createServer();
  const ctx = { connection, logger: { info() {}, warn() {} } };
  const bridge = {
    getState: () => {
      throw new Error("boom: internal secret");
    },
    setEnabled: async () => true,
    paste: async () => ({ ok: true }),
    dispose() {}
  };
  registerDesktopRoutes(ctx, bridge);
  const response = await routes.get(DESKTOP_PATH).fetch(new Request("http://127.0.0.1/api/wordhelper/desktop", { method: "GET" }));
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.code, "internal");
  assert.ok(!JSON.stringify(body).includes("internal secret"));
});

test("释放函数会移除路由", () => {
  const { dispose, routes } = setup();
  assert.equal(routes.size, 1);
  dispose();
  assert.equal(routes.size, 0);
});
