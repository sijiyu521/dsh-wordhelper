/**
 * 划词助手宿主侧单元测试（不联网）。
 *
 * 用假的 ctx / connection / llm 覆盖路由注册、参数校验、模型错误归一化、
 * 超时与健康检查。运行：node --test test/host-lookup.test.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_TEXT_LENGTH,
  MODES,
  buildMessages,
  normalizeRequest,
} from "../lib/host/prompts.js";
import {
  DEFAULT_TIMEOUT_MS,
  HEALTH_PATH,
  LOOKUP_PATH,
  askModel,
  registerLookupRoutes,
} from "../lib/host/lookup.js";

/** 假默认模型选择。 */
const DEFAULT_SELECTION = Object.freeze({ provider: "deepseek", model: "deepseek-chat" });

/**
 * 构造一个不联网的假宿主上下文。
 * @param {{
 *   llm?: any,
 *   selection?: any,
 *   defaultModelService?: boolean,
 *   connection?: object,
 * }} [options]
 */
function createHarness(options = {}) {
  const routes = new Map();
  const registeredOwners = [];
  const disposed = [];
  const loggerCalls = [];
  const state = {
    llm: options.llm,
    selection: options.selection === undefined ? DEFAULT_SELECTION : options.selection,
  };

  const connection = options.connection ?? {
    registerFetchRoute(owner, route) {
      registeredOwners.push(owner);
      routes.set(route.path, route);
      return () => {
        disposed.push(route.path);
      };
    },
  };

  const ctx = {
    connection,
    logger: {
      warn: (...args) => loggerCalls.push(args),
    },
    get(name) {
      if (name === "connection") return connection;
      if (name === "llm") return state.llm;
      if (name === "agentDefaultModel") {
        return options.defaultModelService === false
          ? undefined
          : { currentSelection: () => state.selection };
      }
      return undefined;
    },
  };

  return { ctx, routes, state, registeredOwners, disposed, loggerCalls };
}

/** 用过一次就返回固定 chunk 列表的假 llm。 */
function llmFromChunks(chunks) {
  return createLlm(function* streamChunks() {
    for (const chunk of chunks) yield chunk;
  });
}

/** 用给定工厂构造假 llm，并记录每次 stream 的 options。 */
function createLlm(factory) {
  const llm = {
    calls: [],
    stream(options) {
      llm.calls.push(options);
      return factory(options);
    },
  };
  return llm;
}

/** 一直挂起、直到 signal 中止才收尾的假 llm（用于超时 / 取消测试）。 */
function hangingLlm() {
  return createLlm((options) =>
    (async function* streamUntilAborted() {
      await new Promise((resolve) => {
        if (options.signal.aborted) {
          resolve();
          return;
        }
        options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      yield {
        type: "finish",
        reason: { kind: "aborted", failure: { code: "ABORTED", message: "aborted" } },
      };
    })(),
  );
}

/** 注册路由并返回 harness + dispose。 */
function registeredHarness(options = {}) {
  const harness = createHarness(options);
  const dispose = registerLookupRoutes(harness.ctx, options.routeOptions);
  return { ...harness, dispose };
}

/** 构造一条 lookup POST 请求。 */
function lookupRequest(body, init = {}) {
  return new Request(`http://127.0.0.1${LOOKUP_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

/** 构造一条 health GET 请求。 */
function healthRequest(init = {}) {
  return new Request(`http://127.0.0.1${HEALTH_PATH}`, { method: "GET", ...init });
}

/** 取已注册的路由并调用它的 fetch。 */
async function callRoute(routes, path, request) {
  const route = routes.get(path);
  assert.ok(route, `route ${path} should be registered`);
  return route.fetch(request);
}

/** 断言响应是 JSON 且带统一头。 */
function assertJsonResponse(response) {
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
}

// ---------------------------------------------------------------------------
// prompts.js
// ---------------------------------------------------------------------------

test("prompts: 常量与模式", () => {
  assert.ok(Object.isFrozen(MODES));
  assert.deepEqual([...MODES], ["translate", "explain"]);
  assert.equal(MAX_TEXT_LENGTH, 4000);
});

test("normalizeRequest: 正常归一化（trim）", () => {
  assert.deepEqual(normalizeRequest({ mode: "translate", text: "  hello  " }), {
    ok: true,
    mode: "translate",
    text: "hello",
  });
  assert.deepEqual(normalizeRequest({ mode: "explain", text: "ephemeral\n" }), {
    ok: true,
    mode: "explain",
    text: "ephemeral",
  });
});

test("normalizeRequest: 4000 通过、4001 拒绝", () => {
  const atLimit = normalizeRequest({ mode: "translate", text: "a".repeat(MAX_TEXT_LENGTH) });
  assert.equal(atLimit.ok, true);
  assert.equal(atLimit.text.length, MAX_TEXT_LENGTH);

  const overLimit = normalizeRequest({ mode: "translate", text: "a".repeat(MAX_TEXT_LENGTH + 1) });
  assert.equal(overLimit.ok, false);
  assert.equal(overLimit.code, "text-too-long");
  assert.match(overLimit.message, /[\u4e00-\u9fff]/);

  // 长度按 trim 后计算。
  const padded = normalizeRequest({
    mode: "translate",
    text: `   ${"a".repeat(MAX_TEXT_LENGTH)}   `,
  });
  assert.equal(padded.ok, true);
});

test("normalizeRequest: 非法输入", () => {
  for (const body of [null, undefined, [], "text", 42, true]) {
    const result = normalizeRequest(body);
    assert.equal(result.ok, false, `body ${String(body)} should be rejected`);
    assert.equal(result.code, "invalid-body");
  }

  for (const mode of ["summarize", "Translate", "", null, 42]) {
    const result = normalizeRequest({ mode, text: "hello" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "invalid-mode");
  }

  for (const text of ["", "   \n\t ", null, 42, undefined]) {
    const result = normalizeRequest({ mode: "translate", text });
    assert.equal(result.ok, false);
    assert.ok(result.code === "empty-text" || result.code === "invalid-body");
  }

  assert.match(normalizeRequest({}).message, /[\u4e00-\u9fff]/);
});

test("buildMessages: 单条 user 消息 + 围栏包裹文本", () => {
  const translated = buildMessages("translate", "Hello");
  assert.equal(translated.length, 1);
  assert.equal(translated[0].role, "user");
  assert.equal(translated[0].content.length, 1);
  assert.equal(translated[0].content[0].type, "text");

  const translateText = translated[0].content[0].text;
  assert.match(translateText, /翻译/);
  assert.ok(translateText.endsWith("```\nHello\n```"));

  const explained = buildMessages("explain", "ephemeral");
  const explainText = explained[0].content[0].text;
  assert.match(explainText, /解释/);
  assert.ok(explainText.endsWith("```\nephemeral\n```"));
  assert.notEqual(explainText, translateText.replace("Hello", "ephemeral"));

  // 文本里带反引号时围栏自动加长，避免提前闭合。
  const tricky = "代码 ```x``` 示例";
  const fenced = buildMessages("translate", tricky)[0].content[0].text;
  assert.ok(fenced.includes("````\n代码 ```x``` 示例\n````"));

  assert.throws(() => buildMessages("summarize", "x"), TypeError);
});

// ---------------------------------------------------------------------------
// 路由注册 / 释放
// ---------------------------------------------------------------------------

test("registerLookupRoutes: 两条精确路由 + 幂等释放", () => {
  const harness = createHarness();
  const dispose = registerLookupRoutes(harness.ctx);

  assert.deepEqual([...harness.routes.keys()].sort(), [HEALTH_PATH, LOOKUP_PATH].sort());
  assert.equal(harness.registeredOwners.length, 2);
  assert.ok(harness.registeredOwners.every((owner) => owner === harness.ctx));

  for (const path of [LOOKUP_PATH, HEALTH_PATH]) {
    assert.ok(path.startsWith("/api/"));
    const route = harness.routes.get(path);
    assert.equal(route.requestBody, "buffered");
    assert.ok(Array.isArray(route.methods) && route.methods.length > 0);
    assert.equal(new Set(route.methods).size, route.methods.length);
    assert.equal(typeof route.fetch, "function");
  }
  assert.ok(harness.routes.get(LOOKUP_PATH).methods.includes("POST"));
  assert.ok(harness.routes.get(HEALTH_PATH).methods.includes("GET"));

  dispose();
  assert.deepEqual(harness.disposed.sort(), [HEALTH_PATH, LOOKUP_PATH].sort());
  assert.doesNotThrow(() => dispose());
  assert.equal(harness.disposed.length, 2);
});

test("registerLookupRoutes: 第二条注册失败时释放已注册路由", () => {
  const disposed = [];
  const connection = {
    registerFetchRoute(owner, route) {
      if (route.path === LOOKUP_PATH) throw new Error("route already registered");
      return () => {
        disposed.push(route.path);
      };
    },
  };
  const harness = createHarness({ connection });
  assert.throws(() => registerLookupRoutes(harness.ctx), /already registered/);
  assert.deepEqual(disposed, [HEALTH_PATH]);
});

test("registerLookupRoutes: 缺少 connection 服务时抛明确错误", () => {
  const ctx = { get: () => undefined };
  assert.throws(() => registerLookupRoutes(ctx), /client-connection/);
});

// ---------------------------------------------------------------------------
// POST /api/wordhelper/lookup —— 正常路径
// ---------------------------------------------------------------------------

test("lookup: translate 正常（忽略 reasoning-delta）", async () => {
  const llm = llmFromChunks([
    { type: "block-start", index: 0, blockType: "reasoning" },
    { type: "reasoning-delta", index: 0, text: "不要出现在结果里" },
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "  Hello" },
    { type: "text-delta", index: 0, text: ", 世界  " },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  const harness = registeredHarness({ llm });

  const response = await callRoute(
    harness.routes,
    LOOKUP_PATH,
    lookupRequest({ mode: "translate", text: "Hello, 世界" }),
  );

  assert.equal(response.status, 200);
  assertJsonResponse(response);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ["elapsedMs", "mode", "ok", "text"]);
  assert.equal(body.ok, true);
  assert.equal(body.mode, "translate");
  assert.equal(body.text, "Hello, 世界");
  assert.equal(typeof body.elapsedMs, "number");
  assert.ok(body.elapsedMs >= 0);
  assert.ok(!body.text.includes("不要出现在结果里"));

  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].provider, "deepseek");
  assert.equal(llm.calls[0].model, "deepseek-chat");
  assert.ok(llm.calls[0].signal instanceof AbortSignal);
  assert.equal(llm.calls[0].messages.length, 1);
  assert.equal(llm.calls[0].messages[0].role, "user");
  const prompt = llm.calls[0].messages[0].content[0].text;
  assert.match(prompt, /翻译/);
  assert.ok(prompt.includes("Hello, 世界"));

  harness.dispose();
});

test("lookup: explain 正常", async () => {
  const llm = llmFromChunks([
    { type: "text-delta", index: 0, text: "1. 含义：短暂的。\n2. 用法：形容事物。" },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  const harness = registeredHarness({ llm });

  const response = await callRoute(
    harness.routes,
    LOOKUP_PATH,
    lookupRequest({ mode: "explain", text: "ephemeral" }),
  );

  assert.equal(response.status, 200);
  assertJsonResponse(response);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.mode, "explain");
  assert.match(body.text, /含义/);
  assert.match(llm.calls[0].messages[0].content[0].text, /解释/);
});

// ---------------------------------------------------------------------------
// POST /api/wordhelper/lookup —— 参数错误
// ---------------------------------------------------------------------------

test("lookup: 非法 mode → 400 invalid-mode", async () => {
  const llm = llmFromChunks([{ type: "finish", reason: { kind: "stop" } }]);
  const harness = registeredHarness({ llm });

  const response = await callRoute(
    harness.routes,
    LOOKUP_PATH,
    lookupRequest({ mode: "summarize", text: "hello" }),
  );
  assert.equal(response.status, 400);
  assertJsonResponse(response);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "invalid-mode");
  assert.match(body.message, /[\u4e00-\u9fff]/);
  assert.equal(llm.calls.length, 0);
});

test("lookup: 空 text → 400 empty-text", async () => {
  const llm = llmFromChunks([{ type: "finish", reason: { kind: "stop" } }]);
  const harness = registeredHarness({ llm });

  const response = await callRoute(
    harness.routes,
    LOOKUP_PATH,
    lookupRequest({ mode: "translate", text: "   \n\t " }),
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "empty-text");
  assert.equal(llm.calls.length, 0);
});

test("lookup: 超长 text → 400 text-too-long", async () => {
  const llm = llmFromChunks([{ type: "finish", reason: { kind: "stop" } }]);
  const harness = registeredHarness({ llm });

  const response = await callRoute(
    harness.routes,
    LOOKUP_PATH,
    lookupRequest({ mode: "translate", text: "a".repeat(MAX_TEXT_LENGTH + 1) }),
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "text-too-long");
  assert.equal(llm.calls.length, 0);
});

test("lookup: 请求体不是 JSON / 不是对象 → 400 invalid-body", async () => {
  const llm = llmFromChunks([{ type: "finish", reason: { kind: "stop" } }]);
  const harness = registeredHarness({ llm });

  const malformed = await callRoute(harness.routes, LOOKUP_PATH, lookupRequest("not json at all"));
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, "invalid-body");

  const scalar = await callRoute(
    harness.routes,
    LOOKUP_PATH,
    lookupRequest(JSON.stringify("just a string")),
  );
  assert.equal(scalar.status, 400);
  assert.equal((await scalar.json()).code, "invalid-body");
  assert.equal(llm.calls.length, 0);
});

// ---------------------------------------------------------------------------
// POST /api/wordhelper/lookup —— 模型不可用
// ---------------------------------------------------------------------------

test("lookup: 没有 llm 服务 → 503 llm-unavailable", async () => {
  const harness = registeredHarness({ llm: undefined });

  const response = await callRoute(
    harness.routes,
    LOOKUP_PATH,
    lookupRequest({ mode: "translate", text: "hello" }),
  );
  assert.equal(response.status, 503);
  assertJsonResponse(response);
  const body = await response.json();
  assert.equal(body.code, "llm-unavailable");
  assert.match(body.message, /[\u4e00-\u9fff]/);
});

test("lookup: 没有默认模型 → 503 no-model", async () => {
  const cases = [
    { defaultModelService: false },
    { selection: null },
    { selection: {} },
    { selection: { provider: "deepseek" } },
    { selection: { provider: "", model: "deepseek-chat" } },
  ];

  for (const options of cases) {
    const llm = llmFromChunks([{ type: "finish", reason: { kind: "stop" } }]);
    const harness = registeredHarness({ ...options, llm });
    const response = await callRoute(
      harness.routes,
      LOOKUP_PATH,
      lookupRequest({ mode: "translate", text: "hello" }),
    );
    assert.equal(response.status, 503, JSON.stringify(options));
    const body = await response.json();
    assert.equal(body.code, "no-model", JSON.stringify(options));
    assert.equal(llm.calls.length, 0);
  }
});

// ---------------------------------------------------------------------------
// POST /api/wordhelper/lookup —— 模型侧错误
// ---------------------------------------------------------------------------

test("lookup: finish error → 502 provider-error（不泄漏内部信息）", async () => {
  const llm = llmFromChunks([
    { type: "text-delta", index: 0, text: "部分结果" },
    {
      type: "finish",
      reason: { kind: "error", failure: { code: "RATE_LIMIT", message: "429 too many requests" } },
    },
  ]);
  const harness = registeredHarness({ llm });

  const response = await callRoute(
    harness.routes,
    LOOKUP_PATH,
    lookupRequest({ mode: "translate", text: "SECRET_USER_TEXT" }),
  );
  assert.equal(response.status, 502);
  assertJsonResponse(response);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "provider-error");
  assert.match(body.message, /[\u4e00-\u9fff]/);
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("RATE_LIMIT"));
  assert.ok(!serialized.includes("SECRET_USER_TEXT"));
});

test("lookup: stream 抛错 → 502 provider-error 且日志不含用户文本", async () => {
  const llm = createLlm(function* brokenStream() {
    throw new Error("socket hang up");
  });
  const harness = registeredHarness({ llm });

  const response = await callRoute(
    harness.routes,
    LOOKUP_PATH,
    lookupRequest({ mode: "translate", text: "SECRET_USER_TEXT" }),
  );
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "provider-error");
  assert.ok(harness.loggerCalls.length > 0);
  const logs = harness.loggerCalls.flat().map(String).join("\n");
  assert.ok(!logs.includes("SECRET_USER_TEXT"));
});

test("lookup: stream 同步抛错 → 502 provider-error", async () => {
  const llm = {
    calls: [],
    stream() {
      throw new Error("adapter missing");
    },
  };
  const harness = registeredHarness({ llm });

  const response = await callRoute(
    harness.routes,
    LOOKUP_PATH,
    lookupRequest({ mode: "translate", text: "hello" }),
  );
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, "provider-error");
});

test("lookup: 模型返回空正文 → 502 empty-result", async () => {
  const cases = [
    [{ type: "finish", reason: { kind: "stop" } }],
    [
      { type: "text-delta", index: 0, text: "   \n " },
      { type: "finish", reason: { kind: "stop" } },
    ],
  ];
  for (const chunks of cases) {
    const harness = registeredHarness({ llm: llmFromChunks(chunks) });
    const response = await callRoute(
      harness.routes,
      LOOKUP_PATH,
      lookupRequest({ mode: "translate", text: "hello" }),
    );
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "empty-result");
  }
});

test("lookup: 未捕获异常 → 500 internal + 告警日志", async () => {
  const brokenSelection = {};
  Object.defineProperty(brokenSelection, "provider", {
    get() {
      throw new Error("settings unreachable");
    },
  });
  const llm = llmFromChunks([{ type: "finish", reason: { kind: "stop" } }]);
  const harness = registeredHarness({ llm, selection: brokenSelection });

  const response = await callRoute(
    harness.routes,
    LOOKUP_PATH,
    lookupRequest({ mode: "translate", text: "SECRET_USER_TEXT" }),
  );
  assert.equal(response.status, 500);
  assertJsonResponse(response);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "internal");
  assert.match(body.message, /[\u4e00-\u9fff]/);
  assert.ok(harness.loggerCalls.length > 0);
  const logs = harness.loggerCalls.flat().map(String).join("\n");
  assert.ok(!logs.includes("SECRET_USER_TEXT"));
});

// ---------------------------------------------------------------------------
// askModel —— 超时 / 取消
// ---------------------------------------------------------------------------

test("askModel: 默认超时常量", () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 30_000);
});

test("askModel: 超时 → timeout", { timeout: 5_000 }, async () => {
  const llm = hangingLlm();
  const harness = createHarness({ llm });

  const result = await askModel(harness.ctx, {
    mode: "translate",
    text: "hello",
    timeoutMs: 20,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "timeout");
  assert.match(result.message, /超时/);
  assert.equal(llm.calls.length, 1);
});

test("lookup: 路由超时 → 504 timeout", { timeout: 5_000 }, async () => {
  const harness = registeredHarness({ llm: hangingLlm(), routeOptions: { timeoutMs: 20 } });

  const response = await callRoute(
    harness.routes,
    LOOKUP_PATH,
    lookupRequest({ mode: "translate", text: "hello" }),
  );
  assert.equal(response.status, 504);
  assert.equal((await response.json()).code, "timeout");
});

test("askModel: 外部 signal 中止 → provider-error（不泄漏堆栈）", { timeout: 5_000 }, async () => {
  const llm = hangingLlm();
  const harness = createHarness({ llm });
  const controller = new AbortController();

  const pending = askModel(harness.ctx, {
    mode: "translate",
    text: "hello",
    signal: controller.signal,
    timeoutMs: 30_000,
  });
  setTimeout(() => controller.abort(), 10);
  const result = await pending;

  assert.equal(result.ok, false);
  assert.equal(result.code, "provider-error");
  assert.equal(result.message, "请求已取消");
});

test("askModel: signal 已中止时不调用模型", async () => {
  const llm = hangingLlm();
  const harness = createHarness({ llm });
  const controller = new AbortController();
  controller.abort();

  const result = await askModel(harness.ctx, {
    mode: "translate",
    text: "hello",
    signal: controller.signal,
    timeoutMs: 30_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "provider-error");
  assert.equal(llm.calls.length, 0);
});

// ---------------------------------------------------------------------------
// GET /api/wordhelper/health
// ---------------------------------------------------------------------------

test("health: 有默认模型时返回 provider/model", async () => {
  const harness = registeredHarness();

  const response = await callRoute(harness.routes, HEALTH_PATH, healthRequest());
  assert.equal(response.status, 200);
  assertJsonResponse(response);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: true,
    service: "dsh-wordhelper",
    llm: { provider: "deepseek", model: "deepseek-chat" },
  });
});

test("health: 拿不到默认模型时 llm 为 null", async () => {
  const cases = [
    { defaultModelService: false },
    { selection: null },
    { selection: {} },
    { selection: { provider: "", model: "" } },
  ];

  for (const options of cases) {
    const harness = registeredHarness(options);
    const response = await callRoute(harness.routes, HEALTH_PATH, healthRequest());
    assert.equal(response.status, 200, JSON.stringify(options));
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.llm, null, JSON.stringify(options));
  }
});

test("health: 没有 llm 服务但模型有配置时仍返回可用选择", async () => {
  const harness = registeredHarness({ llm: undefined });
  const response = await callRoute(harness.routes, HEALTH_PATH, healthRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.llm, { provider: "deepseek", model: "deepseek-chat" });
});

// ---------------------------------------------------------------------------
// 其它方法 → 405
// ---------------------------------------------------------------------------

test("非主方法 → 405 + allow", async () => {
  const harness = registeredHarness();

  const lookupResponse = await callRoute(
    harness.routes,
    LOOKUP_PATH,
    new Request(`http://127.0.0.1${LOOKUP_PATH}`, { method: "GET" }),
  );
  assert.equal(lookupResponse.status, 405);
  assert.equal(lookupResponse.headers.get("allow"), "POST");
  assert.equal(await lookupResponse.text(), "method not allowed");

  const healthResponse = await callRoute(
    harness.routes,
    HEALTH_PATH,
    new Request(`http://127.0.0.1${HEALTH_PATH}`, { method: "POST", body: "{}" }),
  );
  assert.equal(healthResponse.status, 405);
  assert.equal(healthResponse.headers.get("allow"), "GET");
});
