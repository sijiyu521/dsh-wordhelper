/**
 * 划词助手 —— 宿主侧 `/api` 查询路由。
 *
 * 两条精确路由注册在 client-connection 的 `/api` 通道上（该通道统一负责
 * 浏览器认证与 Host/Origin 校验）：
 *   - `POST /api/wordhelper/lookup` 翻译 / 解释选中的文字；
 *   - `GET  /api/wordhelper/health` 告知客户端当前是否有可用的默认模型。
 *
 * 只使用标准 Fetch API，不 import 任何 `@deepseek-ai/*` 包。
 * @module dsh-wordhelper/lib/host/lookup
 */

import { buildMessages, normalizeRequest } from "./prompts.js";

/** 查询路由路径（必须以 `/api/` 开头，且必须是精确路径）。 */
export const LOOKUP_PATH = "/api/wordhelper/lookup";

/** 健康检查路由路径。 */
export const HEALTH_PATH = "/api/wordhelper/health";

/** 单次模型调用的默认超时（毫秒）。 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * @typedef {{ ok: true, text: string, elapsedMs: number }} LookupSuccess
 * @typedef {{ ok: false, code: string, message: string }} LookupFailure
 */

/** 所有 JSON 响应共用的响应头。 */
const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

/** 失败码 → HTTP 状态码。 */
const FAILURE_STATUS = Object.freeze({
  "invalid-body": 400,
  "invalid-mode": 400,
  "empty-text": 400,
  "text-too-long": 400,
  "llm-unavailable": 503,
  "no-model": 503,
  "provider-error": 502,
  "empty-result": 502,
  timeout: 504,
  internal: 500,
});

/** 请求体在通道侧已完整缓冲。 */
const BUFFERED = "buffered";

/**
 * 查询路由声明的方法：除主方法外也接收常见方法，这样它们会得到本路由的
 * 405（而不是通道的 404）。
 */
const LOOKUP_METHODS = Object.freeze(["POST", "GET", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** 健康检查路由声明的方法（同上）。 */
const HEALTH_METHODS = Object.freeze(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/**
 * 在 client-connection 的 `/api` 通道上注册两条精确路由。
 * @param {object} ctx - 宿主插件上下文；需要 `connection` 服务。
 * @param {{ timeoutMs?: number }} [options] - 可选配置；目前只支持超时（毫秒）。
 * @returns {() => void} 幂等的释放函数；重复调用不会抛错。
 */
export function registerLookupRoutes(ctx, options = {}) {
  if (ctx === null || typeof ctx !== "object") {
    throw new TypeError("dsh-wordhelper: registerLookupRoutes requires a plugin context");
  }
  const connection = resolveConnection(ctx);
  const timeoutMs = normalizeTimeout(options?.timeoutMs);

  /** @type {Array<(() => void) | undefined>} */
  const disposers = [];
  let disposed = false;

  /** 幂等释放：单个 disposer 失败不影响其它 disposer，也不向外抛错。 */
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    while (disposers.length > 0) {
      const disposer = disposers.pop();
      try {
        disposer?.();
      } catch (error) {
        logWarning(ctx, "释放 /api 路由失败", error);
      }
    }
  };

  try {
    disposers.push(
      connection.registerFetchRoute(ctx, {
        path: HEALTH_PATH,
        methods: [...HEALTH_METHODS],
        requestBody: BUFFERED,
        fetch: (request) => guarded(ctx, "health", () => handleHealth(ctx, request)),
      }),
    );
    disposers.push(
      connection.registerFetchRoute(ctx, {
        path: LOOKUP_PATH,
        methods: [...LOOKUP_METHODS],
        requestBody: BUFFERED,
        fetch: (request) => guarded(ctx, "lookup", () => handleLookup(ctx, request, timeoutMs)),
      }),
    );
  } catch (error) {
    dispose();
    throw error;
  }

  return dispose;
}

/**
 * 调用默认模型，把流式 chunk 拼接成纯文本。
 * @param {object} ctx - 宿主插件上下文（通过 `ctx.get` 读取 `llm` 与 `agentDefaultModel`）。
 * @param {{ mode: string, text: string, signal?: AbortSignal, timeoutMs?: number }} request
 *   已归一化的请求；`signal` 用于响应客户端断开。
 * @returns {Promise<LookupSuccess | LookupFailure>} 成功时 text 已 trim，elapsedMs 为模型耗时。
 */
export async function askModel(ctx, { mode, text, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const startedAt = Date.now();
  const elapsed = () => Math.max(0, Date.now() - startedAt);

  const llm = getService(ctx, "llm");
  if (llm === null || llm === undefined || typeof llm.stream !== "function") {
    return failure("llm-unavailable", "模型服务当前不可用");
  }

  const selection = readDefaultSelection(ctx);
  if (selection === undefined) {
    return failure("no-model", "尚未配置默认模型");
  }

  if (signal?.aborted === true) {
    return failure("provider-error", "请求已取消");
  }

  // buildMessages 在 mode 非法时会抛错，交给上层兜底成 500，而不是伪装成模型错误。
  const messages = buildMessages(mode, text);

  const controller = new AbortController();
  const effectiveTimeout = normalizeTimeout(timeoutMs);
  let timedOut = false;
  let externallyAborted = false;
  let timer;

  /** 外部 signal 中止时同步中止本次模型调用。 */
  const onExternalAbort = () => {
    externallyAborted = true;
    controller.abort();
  };

  if (signal !== undefined && signal !== null) {
    if (signal.aborted) {
      onExternalAbort();
    } else {
      signal.addEventListener("abort", onExternalAbort, { once: true });
      // 消除“检查与注册监听之间已中止”的竞态。
      if (signal.aborted) onExternalAbort();
    }
  }
  if (externallyAborted) {
    return failure("provider-error", "请求已取消");
  }

  timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, effectiveTimeout);

  let output = "";
  let finishKind;
  let streamFailed = false;

  try {
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.model,
      messages,
      signal: controller.signal,
    })) {
      if (chunk === null || typeof chunk !== "object") continue;
      if (chunk.type === "text-delta") {
        if (typeof chunk.text === "string") output += chunk.text;
        continue;
      }
      if (chunk.type === "finish") {
        // 真实的成功原因是 stop / max-tokens / tool-calls：只要不是 error/aborted 就算结束。
        finishKind = chunk.reason?.kind;
        break;
      }
    }
  } catch (error) {
    if (!timedOut && !externallyAborted) {
      streamFailed = true;
      logWarning(ctx, "模型流读取失败", error);
    }
  } finally {
    clearTimeout(timer);
    try {
      signal?.removeEventListener?.("abort", onExternalAbort);
    } catch {
      // 无视清理失败：signal 可能是极简的假对象。
    }
  }

  if (timedOut) return failure("timeout", "模型响应超时，请稍后再试");
  if (externallyAborted) return failure("provider-error", "请求已取消");
  if (streamFailed) return failure("provider-error", "模型服务调用失败");
  if (finishKind === "error" || finishKind === "aborted") {
    return failure("provider-error", finishKind === "aborted" ? "模型请求被中断" : "模型服务返回错误");
  }

  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return failure("empty-result", "模型没有返回内容");
  }
  return { ok: true, text: trimmed, elapsedMs: elapsed() };
}

/**
 * 处理健康检查请求。
 * @param {object} ctx - 宿主上下文。
 * @param {Request} request - Fetch 请求。
 * @returns {Response}
 */
function handleHealth(ctx, request) {
  if (request?.method !== "GET") return methodNotAllowed("GET");
  const selection = readDefaultSelection(ctx);
  return jsonResponse({
    ok: true,
    service: "dsh-wordhelper",
    llm: selection === undefined ? null : { provider: selection.provider, model: selection.model },
  });
}

/**
 * 处理翻译 / 解释请求。
 * @param {object} ctx - 宿主上下文。
 * @param {Request} request - Fetch 请求（请求体已缓冲）。
 * @param {number} timeoutMs - 本次调用的超时（毫秒）。
 * @returns {Promise<Response>}
 */
async function handleLookup(ctx, request, timeoutMs) {
  if (request?.method !== "POST") return methodNotAllowed("POST");

  let body;
  try {
    body = await request.json();
  } catch {
    return failureResponse("invalid-body", "请求体不是合法的 JSON");
  }

  const normalized = normalizeRequest(body);
  if (!normalized.ok) {
    return failureResponse(normalized.code, normalized.message);
  }

  const result = await askModel(ctx, {
    mode: normalized.mode,
    text: normalized.text,
    signal: request.signal,
    timeoutMs,
  });
  if (!result.ok) {
    return failureResponse(result.code, result.message);
  }

  return jsonResponse({
    ok: true,
    mode: normalized.mode,
    text: result.text,
    elapsedMs: result.elapsedMs,
  });
}

/**
 * 兜底包装：任何未捕获异常都转成 500 JSON，并记录一条不含用户文本的日志。
 * @param {object} ctx - 宿主上下文（logger 可选）。
 * @param {string} label - 日志标签。
 * @param {() => Response | Promise<Response>} run - 实际处理函数。
 * @returns {Promise<Response>}
 */
async function guarded(ctx, label, run) {
  try {
    return await run();
  } catch (error) {
    logWarning(ctx, `${label} 路由处理失败`, error);
    return failureResponse("internal", "划词助手内部错误");
  }
}

/**
 * 生成 JSON 响应（统一 UTF-8 与 no-store 头）。
 * @param {unknown} body - 可 JSON 序列化的响应体。
 * @param {number} [status] - HTTP 状态码。
 * @returns {Response}
 */
function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/**
 * 生成失败 JSON 响应；状态码由失败码决定。
 * @param {string} code - 失败码。
 * @param {string} message - 面向用户的中文短句。
 * @returns {Response}
 */
function failureResponse(code, message) {
  return jsonResponse({ ok: false, code, message }, FAILURE_STATUS[code] ?? 500);
}

/**
 * 方法不允许的响应。
 * @param {string} allow - 该路径真正允许的方法。
 * @returns {Response}
 */
function methodNotAllowed(allow) {
  return new Response("method not allowed", {
    status: 405,
    headers: {
      allow,
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

/**
 * 读取 client-connection 服务；缺失时给出明确错误（由插件入口捕获并降级）。
 * @param {object} ctx - 宿主上下文。
 * @returns {{ registerFetchRoute: Function }}
 */
function resolveConnection(ctx) {
  const connection = getService(ctx, "connection");
  if (connection === null || connection === undefined || typeof connection.registerFetchRoute !== "function") {
    throw new Error("dsh-wordhelper: client-connection 服务不可用，无法注册 /api 路由");
  }
  return connection;
}

/**
 * 容错地读取服务：先走 `ctx.get(name)`，再尝试同名属性。
 * @param {object} ctx - 宿主上下文。
 * @param {string} name - 服务名。
 * @returns {any} 服务实例或 undefined。
 */
function getService(ctx, name) {
  try {
    const service = ctx?.get?.(name);
    if (service !== undefined) return service;
  } catch {
    // 某些上下文的 get 会对未注入服务抛错，忽略后继续尝试属性访问。
  }
  try {
    return ctx?.[name];
  } catch {
    return undefined;
  }
}

/**
 * 读取默认模型选择；服务缺失或选择不完整时返回 undefined。
 * @param {object} ctx - 宿主上下文。
 * @returns {{ provider: string, model: string } | undefined}
 */
function readDefaultSelection(ctx) {
  const service = getService(ctx, "agentDefaultModel");
  if (service === null || service === undefined) return undefined;

  let selection;
  try {
    selection = typeof service.currentSelection === "function" ? service.currentSelection() : undefined;
  } catch {
    return undefined;
  }
  if (selection === null || typeof selection !== "object") return undefined;

  const { provider, model } = selection;
  if (typeof provider !== "string" || provider.length === 0) return undefined;
  if (typeof model !== "string" || model.length === 0) return undefined;
  return { provider, model };
}

/**
 * 把任意输入归一化为合法超时值。
 * @param {unknown} value - 候选超时（毫秒）。
 * @returns {number}
 */
function normalizeTimeout(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/**
 * 记录告警日志；绝不包含选中的用户文本，日志失败也不影响响应。
 * @param {object} ctx - 宿主上下文（logger 可选）。
 * @param {string} label - 简短标签。
 * @param {unknown} error - 异常或补充信息。
 */
function logWarning(ctx, label, error) {
  try {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    ctx?.logger?.warn?.(`[dsh-wordhelper] ${label}: ${detail}`);
  } catch {
    // 日志不可用时保持静默。
  }
}

/**
 * 构造统一的失败结果。
 * @param {string} code - 英文 kebab-case 错误码。
 * @param {string} message - 面向用户的中文短句。
 * @returns {LookupFailure}
 */
function failure(code, message) {
  return { ok: false, code, message };
}
