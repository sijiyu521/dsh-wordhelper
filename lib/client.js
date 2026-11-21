window.__ModuleLoader__.load({
  id: "dsh-wordhelper",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /**
     * dsh-wordhelper —— 浏览器侧。
     *
     * 三个注册点（全部 root 作用域）：
     *   1. `sidebar.panellist` 列表槽：左侧栏的「划词助手」入口图标；
     *       同一个 id 寻址布局 `main` 键槽里的主面板。
     *   2. `main` 键槽（key = "wordhelper"）：划词本主面板。
     *   3. `shell.overlay`：全局划词浮条，跟随选区出现在页面上方。
     *
     * 这一份文件是经典脚本（懒 CJS 工厂），**不能写 import/export 语句**；
     * 只能 require 基座里的共享模块，这里只用到 react。
     */

    const React = require("react");
    // react-dom 在基座共享模块表里（官方 Menu / Tooltip 也是这么用的）。
    // 浮条必须挂到 body 上：侧栏折叠动画会给祖先加 transform，
    // 那样 position: fixed 会退化成相对祖先定位，浮条就跑到左边或干脆被裁掉。
    const ReactDOM = require("react-dom");
    const h = React.createElement;
    const Fragment = React.Fragment;

    const PANEL_ID = "wordhelper";
    const SIDEBAR_ORDER = 18;
    const STYLE_ID = "dsh-wordhelper-style";
    const STORAGE_KEY = "dsh-wordhelper:v2";
    const MAX_ENTRIES = 200;
    const MAX_TEXT = 4000;
    const API_LOOKUP = "/api/wordhelper/lookup";
    const API_HEALTH = "/api/wordhelper/health";
    const API_DESKTOP = "/api/wordhelper/desktop";
    const PORTAL_ATTR = "data-dsh-wordhelper-portal";

    /** 浮条上可选的动作；顺序即渲染顺序。 */
    const ACTIONS = [
      { id: "translate", label: "翻译", hint: "翻译成中文，原文是中文就译成英文" },
      { id: "explain", label: "解释", hint: "解释含义、用法或背景" },
      { id: "copy", label: "复制", hint: "把选中的文字复制到剪贴板" },
      { id: "search", label: "搜索", hint: "在浏览器里搜索这段文字" },
      { id: "save", label: "收藏", hint: "收进划词本" }
    ];
    const DEFAULT_ACTION_IDS = ACTIONS.map(function (action) {
      return action.id;
    });
    const MIN_LENGTH_OPTIONS = [
      { value: 1, label: "1 字" },
      { value: 2, label: "2 字" },
      { value: 5, label: "5 字" },
      { value: 10, label: "10 字" }
    ];

    const CSS = [
      ".wh-panel{box-sizing:border-box;height:100%;min-height:0;overflow-y:auto;display:flex;flex-direction:column;align-items:center;gap:16px;padding:28px clamp(20px,4vw,48px) 56px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit)}",
      ".wh-panel>*{width:100%;max-width:880px}",
      ".wh-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}",
      ".wh-title{margin:0;font-size:20px;line-height:28px;font-weight:600;letter-spacing:.1px}",
      ".wh-sub{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}",
      ".wh-ghost{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;cursor:pointer;transition:background .15s ease,color .15s ease}",
      ".wh-ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".wh-ghost:disabled{opacity:.5;cursor:not-allowed}",
      ".wh-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:2px 16px}",
      ".wh-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}",
      ".wh-row:last-child{border-bottom:0}",
      ".wh-row-text{min-width:0}",
      ".wh-row-label{font-size:13px;font-weight:500;line-height:20px}",
      ".wh-row-desc{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".wh-switch{position:relative;flex:0 0 auto;width:38px;height:22px;padding:0;border-radius:999px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-3);cursor:pointer;transition:background .16s ease,border-color .16s ease}",
      ".wh-switch[data-on=\"true\"]{background:var(--dsw-alias-brand-primary);border-color:transparent}",
      ".wh-switch::after{content:\"\";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);transition:transform .16s ease}",
      ".wh-switch[data-on=\"true\"]::after{transform:translateX(16px)}",
      ".wh-seg{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-3)}",
      ".wh-seg button{height:24px;padding:0 10px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;cursor:pointer}",
      ".wh-seg button[data-on=\"true\"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}",
      ".wh-chips{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end}",
      ".wh-chip{height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;cursor:pointer}",
      ".wh-chip[data-on=\"true\"]{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}",
      ".wh-listhead{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}",
      ".wh-search{display:flex;align-items:center;gap:6px;height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);flex:1 1 240px;min-width:200px}",
      ".wh-search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;font-family:inherit}",
      ".wh-search input::placeholder{color:var(--dsw-alias-label-tertiary)}",
      ".wh-count{font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".wh-entries{display:flex;flex-direction:column;gap:8px}",
      ".wh-entry{display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px;padding:12px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);transition:border-color .15s ease,background .15s ease}",
      ".wh-entry:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2)}",
      ".wh-entry-main{flex:1;min-width:0;cursor:pointer}",
      ".wh-entry-text{font-size:13px;line-height:21px;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}",
      ".wh-entry[data-expanded=\"true\"] .wh-entry-text{display:block;-webkit-line-clamp:unset;overflow:visible}",
      ".wh-entry-meta{margin-top:4px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);display:flex;gap:8px;flex-wrap:wrap}",
      ".wh-entry-actions{display:flex;align-items:center;gap:2px;flex:0 0 auto}",
      ".wh-icon{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}",
      ".wh-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".wh-icon[data-on=\"true\"]{color:var(--dsw-alias-state-warn-primary,#f2b544)}",
      ".wh-icon[data-danger=\"true\"]:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary,#ef4444)}",
      ".wh-entry-result{margin:10px 0 0;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);font-size:12.5px;line-height:20px;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary);max-height:260px;overflow:auto}",
      ".wh-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:44px 16px;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center}",
      ".wh-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
      ".wh-floater{position:fixed;z-index:2147482000;display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none;transform:translateX(-50%)}",
      ".wh-bar{display:flex;align-items:center;gap:2px;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l3);box-shadow:0 10px 28px rgba(0,0,0,.28),0 2px 6px rgba(0,0,0,.16);pointer-events:auto;backdrop-filter:blur(8px)}",
      ".wh-tab{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;cursor:pointer;white-space:nowrap}",
      ".wh-tab:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".wh-tab:disabled{opacity:.42;cursor:not-allowed}",
      ".wh-tab svg{flex:0 0 auto}",
      ".wh-card-result{box-sizing:border-box;width:340px;max-width:min(82vw,340px);padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-2));border:1px solid var(--dsw-alias-border-l3);box-shadow:0 12px 32px rgba(0,0,0,.3);pointer-events:auto;color:var(--dsw-alias-label-primary);backdrop-filter:blur(8px)}",
      ".wh-result-head{display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}",
      ".wh-result-text{font-size:12.5px;line-height:20px;white-space:pre-wrap;word-break:break-word;max-height:42vh;overflow:auto}",
      ".wh-result-error{font-size:12.5px;line-height:20px;color:var(--dsw-alias-state-error-primary,#ef4444)}",
      ".wh-result-loading{font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-tertiary)}",
      ".wh-result-foot{display:flex;gap:6px;justify-content:flex-end;margin-top:8px}",
      ".wh-toast{pointer-events:none;font-size:11px;line-height:1;padding:5px 8px;border-radius:6px;background:var(--dsw-alias-toast-bg,rgba(20,21,24,.92));color:var(--dsw-alias-toast-label,#fff);box-shadow:0 4px 12px rgba(0,0,0,.24)}"
    ].join("\n");

    // #region 小工具

    /** 我们自己触发的复制（execCommand 兜底）不要被 copy 监听当成用户划词。 */
    let suppressCopyCapture = false;

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    function pad2(value) {
      return value < 10 ? "0" + value : String(value);
    }

    function formatTime(timestamp) {
      const date = new Date(timestamp);
      if (Number.isNaN(date.getTime())) return "";
      const now = new Date();
      const clock = pad2(date.getHours()) + ":" + pad2(date.getMinutes());
      if (date.toDateString() === now.toDateString()) return "今天 " + clock;
      const yesterday = new Date(now.getTime() - 86400000);
      if (date.toDateString() === yesterday.toDateString()) return "昨天 " + clock;
      if (date.getFullYear() === now.getFullYear()) {
        return date.getMonth() + 1 + "月" + date.getDate() + "日 " + clock;
      }
      return date.getFullYear() + "年" + (date.getMonth() + 1) + "月" + date.getDate() + "日";
    }

    /** 剪贴板：优先异步 API，退回 execCommand。 */
    async function copyText(text) {
      const value = String(text == null ? "" : text);
      try {
        if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value);
          return true;
        }
      } catch (error) {
        /* 继续走兜底方案 */
      }
      try {
        const area = document.createElement("textarea");
        area.value = value;
        area.setAttribute("readonly", "readonly");
        area.style.position = "fixed";
        area.style.top = "-1000px";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        // execCommand 会派发 copy 事件，先屏蔽掉，免得把我们自己复制的文字当成一次划词。
        suppressCopyCapture = true;
        const ok = document.execCommand("copy");
        suppressCopyCapture = false;
        document.body.removeChild(area);
        return ok;
      } catch (error) {
        suppressCopyCapture = false;
        return false;
      }
    }

    /** 用系统浏览器搜索这段文字；被拦截时返回 false。 */
    function openSearch(text) {
      const url = "https://www.bing.com/search?q=" + encodeURIComponent(String(text).slice(0, 380));
      try {
        const opened = window.open(url, "_blank", "noopener,noreferrer");
        return opened !== null && opened !== undefined;
      } catch (error) {
        return false;
      }
    }

    /** 选区来源：当前文档标题（去掉 “— 产品名” 尾巴）。 */
    function describeSource() {
      try {
        const raw = String(document.title || "");
        const head = raw.split(" — ")[0].split(" - DSH")[0].trim();
        return (head || raw || "当前页面").slice(0, 80);
      } catch (error) {
        return "当前页面";
      }
    }

    function ensureStyle() {
      if (typeof document === "undefined" || typeof document.createElement !== "function") return;
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
    }

    let portalHost = null;

    /** 挂在 body 上的浮层容器；被外部清掉会重新建一个。 */
    function getPortalHost() {
      if (typeof document === "undefined" || typeof document.createElement !== "function") return null;
      if (portalHost !== null && portalHost.isConnected === true) return portalHost;
      const host = document.createElement("div");
      host.setAttribute(PORTAL_ATTR, "1");
      (document.body || document.documentElement).appendChild(host);
      portalHost = host;
      return host;
    }

    function isOwnUi(node) {
      let current = node;
      while (current && current !== document) {
        if (current.nodeType === 1 && typeof current.closest === "function" && current.closest("[data-dsh-wordhelper-ui]") !== null) {
          return true;
        }
        current = current.parentNode;
      }
      return false;
    }

    // #endregion

    // #region 状态仓库（localStorage 持久化）

    function defaultSettings() {
      return {
        enabled: true,
        recordHistory: true,
        minLength: 2,
        actions: DEFAULT_ACTION_IDS.slice()
      };
    }

    function sanitizeSettings(raw) {
      const base = defaultSettings();
      if (raw === null || typeof raw !== "object") return base;
      const actions = Array.isArray(raw.actions)
        ? raw.actions.filter(function (id) {
            return DEFAULT_ACTION_IDS.indexOf(id) >= 0;
          })
        : base.actions;
      const minLength = typeof raw.minLength === "number" && raw.minLength >= 1 && raw.minLength <= 40 ? Math.floor(raw.minLength) : base.minLength;
      return {
        enabled: typeof raw.enabled === "boolean" ? raw.enabled : base.enabled,
        recordHistory: typeof raw.recordHistory === "boolean" ? raw.recordHistory : base.recordHistory,
        minLength: minLength,
        actions: actions
      };
    }

    function sanitizeEntries(raw) {
      if (!Array.isArray(raw)) return [];
      const seen = Object.create(null);
      const entries = [];
      for (let index = 0; index < raw.length; index += 1) {
        const item = raw[index];
        if (item === null || typeof item !== "object") continue;
        const text = typeof item.text === "string" ? item.text.trim().slice(0, MAX_TEXT) : "";
        if (text === "" || seen[text] === true) continue;
        seen[text] = true;
        entries.push({
          id: typeof item.id === "string" && item.id !== "" ? item.id : "e_" + (entries.length + 1) + "_" + Date.now(),
          text: text,
          createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
          favorite: item.favorite === true,
          source: typeof item.source === "string" ? item.source.slice(0, 80) : ""
        });
        if (entries.length >= MAX_ENTRIES) break;
      }
      return entries;
    }

    function loadPersisted() {
      const fallback = { entries: [], settings: defaultSettings() };
      try {
        if (typeof localStorage === "undefined") return fallback;
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === null || raw === "") return fallback;
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object") return fallback;
        return { entries: sanitizeEntries(parsed.entries), settings: sanitizeSettings(parsed.settings) };
      } catch (error) {
        return fallback;
      }
    }

    function createStore() {
      const persisted = loadPersisted();
      let state = {
        entries: persisted.entries,
        settings: persisted.settings,
        host: { checked: false, available: false, provider: null, model: null },
        desktop: { checked: false, supported: false, enabled: false, running: false, error: null, focus: null },
        preview: 0
      };
      const listeners = new Set();

      function emit() {
        listeners.forEach(function (listener) {
          try {
            listener();
          } catch (error) {
            console.warn("dsh-wordhelper: store listener failed", error);
          }
        });
      }

      function persist() {
        try {
          if (typeof localStorage === "undefined") return;
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries: state.entries, settings: state.settings }));
        } catch (error) {
          console.warn("dsh-wordhelper: 保存划词本失败", error);
        }
      }

      function patch(next, shouldPersist) {
        state = Object.assign({}, state, next);
        if (shouldPersist !== false) persist();
        emit();
      }

      function makeId() {
        return "e_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 7);
      }

      return {
        getState: function () {
          return state;
        },
        subscribe: function (listener) {
          listeners.add(listener);
          return function () {
            listeners.delete(listener);
          };
        },
        /** 记录一次划词；同文本已在册时不重复插入（除非显式收藏）。 */
        record: function (text, source, options) {
          const opts = options || {};
          const value = String(text == null ? "" : text).trim().slice(0, MAX_TEXT);
          if (value === "") return null;
          const existing = state.entries.find(function (entry) {
            return entry.text === value;
          });
          if (existing !== undefined) {
            if (opts.favorite === true && existing.favorite !== true) {
              const next = state.entries.map(function (entry) {
                return entry.id === existing.id ? Object.assign({}, entry, { favorite: true }) : entry;
              });
              patch({ entries: next });
            }
            return existing.id;
          }
          const entry = {
            id: makeId(),
            text: value,
            createdAt: Date.now(),
            favorite: opts.favorite === true,
            source: String(source == null ? "" : source).slice(0, 80)
          };
          patch({ entries: [entry].concat(state.entries).slice(0, MAX_ENTRIES) });
          return entry.id;
        },
        toggleFavorite: function (id) {
          const next = state.entries.map(function (entry) {
            return entry.id === id ? Object.assign({}, entry, { favorite: !entry.favorite }) : entry;
          });
          patch({ entries: next });
        },
        remove: function (id) {
          patch({
            entries: state.entries.filter(function (entry) {
              return entry.id !== id;
            })
          });
        },
        clear: function () {
          patch({ entries: [] });
        },
        setSettings: function (partial) {
          patch({ settings: sanitizeSettings(Object.assign({}, state.settings, partial)) });
        },
        toggleAction: function (id) {
          const has = state.settings.actions.indexOf(id) >= 0;
          const actions = has
            ? state.settings.actions.filter(function (value) {
                return value !== id;
              })
            : state.settings.actions.concat([id]);
          patch({ settings: sanitizeSettings(Object.assign({}, state.settings, { actions: actions })) });
        },
        setHost: function (info) {
          patch({ host: Object.assign({}, state.host, info) }, false);
        },
        setDesktop: function (info) {
          patch({ desktop: Object.assign({}, state.desktop, info) }, false);
        },
        /** 面板里的「预览浮条」：让浮条在屏幕中间演示一次，方便确认它到底能不能弹。 */
        showPreview: function () {
          patch({ preview: Date.now() }, false);
        },
        /** 把宿主那边监听到的系统剪贴板内容并进划词本（按文本去重）。 */
        ingestDesktop: function (payload) {
          const items = payload !== null && payload !== undefined && Array.isArray(payload.items) ? payload.items : [];
          if (items.length === 0) return;
          const known = new Set(
            state.entries.map(function (entry) {
              return entry.text;
            })
          );
          const additions = [];
          for (let index = items.length - 1; index >= 0; index -= 1) {
            const item = items[index];
            if (item === null || typeof item !== "object") continue;
            const text = typeof item.text === "string" ? item.text.trim().slice(0, MAX_TEXT) : "";
            if (text === "" || known.has(text)) continue;
            known.add(text);
            additions.push({
              id: makeId(),
              text: text,
              createdAt: typeof item.at === "number" && Number.isFinite(item.at) ? item.at : Date.now(),
              favorite: false,
              source: "剪贴板 · " + String(item.app === undefined || item.app === null || item.app === "" ? "系统" : item.app).slice(0, 60)
            });
          }
          if (additions.length === 0) return;
          patch({ entries: additions.reverse().concat(state.entries).slice(0, MAX_ENTRIES) });
        }
      };
    }

    /** 订阅仓库的某个切片；selector 必须返回稳定引用。 */
    function useStore(store, selector) {
      const read = function () {
        return selector(store.getState());
      };
      return React.useSyncExternalStore(store.subscribe, read, read);
    }

    // #endregion

    // #region 宿主桥接（翻译 / 解释）

    function readJson(response) {
      return response
        .json()
        .catch(function () {
          return null;
        });
    }

    let hostProbe = null;

    /** 探一次宿主能力；同一个页面只探一次。 */
    function probeHost(store) {
      if (hostProbe !== null) return hostProbe;
      hostProbe = fetch(API_HEALTH, { cache: "no-store" })
        .then(readJson)
        .then(function (body) {
          const info = body !== null && typeof body === "object" && body.llm !== null && typeof body.llm === "object" ? body.llm : null;
          store.setHost({
            checked: true,
            available: info !== null,
            provider: info !== null ? info.provider : null,
            model: info !== null ? info.model : null
          });
        })
        .catch(function (error) {
          hostProbe = null;
          store.setHost({ checked: true, available: false, provider: null, model: null });
          console.warn("dsh-wordhelper: 宿主能力探测失败", error);
        });
      return hostProbe;
    }

    /** 请求宿主做一次翻译 / 解释。失败时抛出带中文 message 的 Error。 */
    async function askHost(mode, text) {
      const response = await fetch(API_LOOKUP, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: mode, text: String(text).slice(0, MAX_TEXT) })
      });
      const body = await readJson(response);
      if (response.ok !== true || body === null || body.ok !== true) {
        const message = body !== null && typeof body.message === "string" ? body.message : "划词助手服务暂时不可用（HTTP " + response.status + "）";
        const error = new Error(message);
        error.code = body !== null ? body.code : undefined;
        throw error;
      }
      return body.text;
    }

    /** 读桌面联动状态（监听开关、最近捕获、上一个外部窗口）。 */
    async function fetchDesktopState() {
      const response = await fetch(API_DESKTOP, { cache: "no-store" });
      const body = await readJson(response);
      if (response.ok !== true || body === null || body.ok !== true) {
        throw new Error(body !== null && body.message ? body.message : "桌面联动不可用");
      }
      return body;
    }

    /** 开关全局监听，返回最新状态。 */
    async function setDesktopEnabled(enabled) {
      const response = await fetch(API_DESKTOP, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: enabled === true })
      });
      const body = await readJson(response);
      if (response.ok !== true || body === null || body.ok !== true) {
        throw new Error(body !== null && body.message ? body.message : "切换全局监听失败");
      }
      return body;
    }

    /**
     * 模拟输入：把文字放进剪贴板，切回上一个外部窗口并自动 Ctrl+V。
     * @param {string} text - 要打出去的文字。
     * @param {{ target?: "previous" | "current", delayMs?: number }} [options]
     * @returns {Promise<object>} 宿主返回的结果（ok / message / typed）。
     */
    async function typeIntoWindow(text, options) {
      const settings = options || {};
      const response = await fetch(API_DESKTOP, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "paste",
          text: String(text).slice(0, MAX_TEXT),
          target: settings.target === "current" ? "current" : "previous",
          delayMs: Number.isFinite(settings.delayMs) ? settings.delayMs : 0
        })
      });
      const body = await readJson(response);
      if (body === null || typeof body !== "object") throw new Error("模拟输入没有返回结果");
      return body;
    }

    // #endregion

    // #region 图标

    function IconBase(props) {
      const size = typeof props.size === "number" ? props.size : 15;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          "aria-hidden": "true",
          focusable: "false"
        },
        props.children
      );
    }

    function PanelIcon(props) {
      const size = typeof props.size === "number" ? props.size : 16;
      const stroke = props.active === true ? 1.7 : 1.4;
      return h(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 16 16",
          fill: "none",
          "aria-hidden": "true",
          focusable: "false"
        },
        h("rect", { x: 1.6, y: 2.2, width: 12.8, height: 11.6, rx: 2.6, stroke: "currentColor", strokeWidth: stroke }),
        h("rect", { x: 3.6, y: 6.7, width: 6.4, height: 2.6, rx: 1.3, fill: "currentColor", fillOpacity: 0.22 }),
        h("path", { d: "M4.1 5.2h7.8M4.1 8h5.4M4.1 10.8h4.2", stroke: "currentColor", strokeWidth: stroke, strokeLinecap: "round" }),
        h("path", { d: "M10.3 9.3 14 10.7l-1.6.7-.7 1.6z", fill: "currentColor" })
      );
    }

    function TranslateIcon(props) {
      return h(
        IconBase,
        props,
        h("path", { d: "M2 3.6h6M5 2.2v1.4M3.4 3.6c0 2.4 1.6 4.6 4 5.6M6.9 3.6c0 2.4-1.6 4.6-4 5.6", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" }),
        h("path", { d: "M9 13.2h5M11.5 8.6l-2.6 4.6M11.5 8.6l2.6 4.6", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" })
      );
    }

    function ExplainIcon(props) {
      return h(
        IconBase,
        props,
        h("path", { d: "M8 1.9l1.2 3.3 3.3 1.2-3.3 1.2L8 10.9 6.8 7.6 3.5 6.4l3.3-1.2z", stroke: "currentColor", strokeWidth: 1.3, strokeLinejoin: "round" }),
        h("path", { d: "M12 11.2l.6 1.5 1.5.6-1.5.6-.6 1.5-.6-1.5-1.5-.6 1.5-.6z", fill: "currentColor" })
      );
    }

    function CopyIcon(props) {
      return h(
        IconBase,
        props,
        h("rect", { x: 5.4, y: 5.4, width: 8.2, height: 8.2, rx: 1.8, stroke: "currentColor", strokeWidth: 1.3 }),
        h("path", { d: "M10.6 5.4V3.9c0-.9-.7-1.6-1.6-1.6H3.9c-.9 0-1.6.7-1.6 1.6v5.1c0 .9.7 1.6 1.6 1.6h1.5", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" })
      );
    }

    function SearchIcon(props) {
      return h(
        IconBase,
        props,
        h("circle", { cx: 7, cy: 7, r: 4.6, stroke: "currentColor", strokeWidth: 1.3 }),
        h("path", { d: "M10.4 10.4 14 14", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" })
      );
    }

    function StarIcon(props) {
      const filled = props.filled === true;
      return h(
        IconBase,
        props,
        h("path", {
          d: "M8 2.1l1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.4 4.4 13.4l.7-4.1-3-2.9 4.1-.6z",
          stroke: "currentColor",
          strokeWidth: 1.25,
          strokeLinejoin: "round",
          fill: filled ? "currentColor" : "none"
        })
      );
    }

    function TrashIcon(props) {
      return h(
        IconBase,
        props,
        h("path", { d: "M2.8 4.4h10.4M6.4 4.4V3c0-.5.4-.9.9-.9h1.4c.5 0 .9.4.9.9v1.4M4.2 4.4l.6 8.4c0 .6.5 1.1 1.1 1.1h4.2c.6 0 1.1-.5 1.1-1.1l.6-8.4", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" }),
        h("path", { d: "M6.7 7v4M9.3 7v4", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" })
      );
    }

    function BackIcon(props) {
      return h(
        IconBase,
        props,
        h("path", { d: "M9.8 3.4 5.2 8l4.6 4.6", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" })
      );
    }

    function SendIcon(props) {
      return h(
        IconBase,
        props,
        h("rect", { x: 1.7, y: 3.1, width: 9.4, height: 9.8, rx: 2, stroke: "currentColor", strokeWidth: 1.3 }),
        h("path", { d: "M6.2 8h7.6M11 5.2 13.9 8 11 10.8", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" })
      );
    }

    // #endregion

    // #region 划词浮条

    /** 最近一次指针位置；某些选区量不出 rect 时拿它兜底，别让浮条不出现。 */
    let lastPointer = null;

    function readSelection() {
      if (typeof window === "undefined" || typeof window.getSelection !== "function") return null;
      const selection = window.getSelection();
      if (selection === null || selection.isCollapsed === true || selection.rangeCount === 0) return null;
      const text = String(selection.toString() || "").trim();
      if (text === "") return null;
      const range = selection.getRangeAt(0);
      const measured = range.getBoundingClientRect();
      let rect = measured;
      if (rect === undefined || rect === null || (rect.width === 0 && rect.height === 0)) {
        if (lastPointer === null) return null;
        rect = { left: lastPointer.x, top: lastPointer.y, width: 1, height: 1, right: lastPointer.x + 1, bottom: lastPointer.y + 1 };
      }
      const anchor = selection.anchorNode;
      const element = anchor !== null && anchor.nodeType === 1 ? anchor : anchor !== null ? anchor.parentElement : null;
      if (element !== null && isOwnUi(element)) return null;
      return { text: text, rect: rect, source: describeSource() };
    }

    /** 「预览浮条」用的假选区：放在视口中央。 */
    function previewSelection() {
      const width = typeof window === "undefined" ? 800 : window.innerWidth;
      const height = typeof window === "undefined" ? 600 : window.innerHeight;
      const left = Math.max(24, width / 2 - 140);
      const top = Math.max(120, height / 2 - 10);
      return {
        text: "划词助手：在页面上选中文字，浮条就会出现在这里。",
        rect: { left: left, top: top, width: 280, height: 20, right: left + 280, bottom: top + 20 },
        source: "预览"
      };
    }

    function SelectionToolbar(props) {
      const store = props.store;
      const askHost = props.askHost;
      const settings = useStore(store, function (state) {
        return state.settings;
      });
      const host = useStore(store, function (state) {
        return state.host;
      });
      const preview = useStore(store, function (state) {
        return state.preview;
      });

      const [selection, setSelection] = React.useState(null);
      const [result, setResult] = React.useState(null);
      const [toast, setToast] = React.useState(null);
      const [boxSize, setBoxSize] = React.useState({ width: 260, height: 36 });
      const boxRef = React.useRef(null);
      const selectionRef = React.useRef(null);
      const resultRef = React.useRef(null);
      const toastTimer = React.useRef(0);

      selectionRef.current = selection;
      resultRef.current = result;

      function showToast(message) {
        setToast(message);
        if (toastTimer.current !== 0) window.clearTimeout(toastTimer.current);
        toastTimer.current = window.setTimeout(function () {
          setToast(null);
          toastTimer.current = 0;
        }, 1500);
      }

      function reset() {
        setSelection(null);
        setResult(null);
        setToast(null);
      }

      React.useEffect(function () {
        probeHost(store);
        return function () {
          if (toastTimer.current !== 0) window.clearTimeout(toastTimer.current);
        };
      }, [store]);

      // 面板里的「预览浮条」：不理选区，直接在屏幕中间演示一次。
      React.useEffect(
        function () {
          if (preview === 0) return;
          setSelection(previewSelection());
          setResult(null);
        },
        [preview]
      );

      React.useEffect(
        function () {
          if (typeof document === "undefined") return undefined;
          if (settings.enabled !== true) {
            setSelection(null);
            setResult(null);
            return undefined;
          }

          let selectionTimer = 0;

          function capture() {
            const next = readSelection();
            if (next === null || next.text.length < settings.minLength) return;
            if (settings.recordHistory === true) store.record(next.text, next.source);
            const previous = selectionRef.current;
            if (previous !== null && previous.text === next.text) {
              setSelection({ text: next.text, rect: next.rect, source: previous.source });
            } else {
              setResult(null);
              setSelection(next);
            }
          }

          function scheduleCapture() {
            window.setTimeout(capture, 0);
          }

          function onPointerUp(event) {
            if (typeof event.clientX === "number" && typeof event.clientY === "number" && (event.clientX !== 0 || event.clientY !== 0)) {
              lastPointer = { x: event.clientX, y: event.clientY };
            }
            if (isOwnUi(event.target)) return;
            scheduleCapture();
          }

          function onMouseDown(event) {
            if (isOwnUi(event.target)) return;
            reset();
          }

          /**
           * 选区一变就先「收起」，停手 260ms 后再「弹出」。
           * 光靠 pointerup 在部分场景（双击选词、键盘扩选、拖拽被脚本打断）收不到，
           * 这里补一条兜底触发。
           */
          function onSelectionChange() {
            const selection = window.getSelection();
            if (selection === null || selection.isCollapsed === true) {
              if (selectionTimer !== 0) {
                window.clearTimeout(selectionTimer);
                selectionTimer = 0;
              }
              if (selectionRef.current !== null) reset();
              return;
            }
            if (selectionTimer !== 0) window.clearTimeout(selectionTimer);
            selectionTimer = window.setTimeout(function () {
              selectionTimer = 0;
              capture();
            }, 260);
          }

          function onScroll(event) {
            if (isOwnUi(event.target)) return;
            reset();
          }

          function onResize() {
            reset();
          }

          function onKeyUp(event) {
            if (event.key === "Escape") {
              reset();
              return;
            }
            if (event.shiftKey === true || event.key === "Shift") scheduleCapture();
          }

          /** Ctrl/Cmd+C、右键复制都会走到这里：复制也把浮条叫出来。 */
          function onCopy(event) {
            if (suppressCopyCapture === true) return;
            if (event.target !== null && event.target !== undefined && isOwnUi(event.target)) return;
            scheduleCapture();
          }

          function onKeyDown(event) {
            if (event.key === "Escape") {
              reset();
              return;
            }
            const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
            if (key === "c" && (event.ctrlKey === true || event.metaKey === true)) scheduleCapture();
          }

          document.addEventListener("pointerup", onPointerUp, true);
          document.addEventListener("mousedown", onMouseDown, true);
          document.addEventListener("selectionchange", onSelectionChange);
          document.addEventListener("keyup", onKeyUp, true);
          document.addEventListener("keydown", onKeyDown, true);
          document.addEventListener("copy", onCopy, true);
          window.addEventListener("scroll", onScroll, true);
          window.addEventListener("resize", onResize);
          return function () {
            if (selectionTimer !== 0) window.clearTimeout(selectionTimer);
            document.removeEventListener("pointerup", onPointerUp, true);
            document.removeEventListener("mousedown", onMouseDown, true);
            document.removeEventListener("selectionchange", onSelectionChange);
            document.removeEventListener("keyup", onKeyUp, true);
            document.removeEventListener("keydown", onKeyDown, true);
            document.removeEventListener("copy", onCopy, true);
            window.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", onResize);
          };
        },
        [settings.enabled, settings.minLength, settings.recordHistory, store]
      );

      React.useLayoutEffect(
        function () {
          const node = boxRef.current;
          if (node === null) return;
          const rect = node.getBoundingClientRect();
          setBoxSize(function (previous) {
            if (Math.abs(previous.width - rect.width) < 1 && Math.abs(previous.height - rect.height) < 1) return previous;
            return { width: rect.width, height: rect.height };
          });
        },
        [selection, result]
      );

      if (selection === null) return null;

      const actions = settings.actions;
      const visibleActions = ACTIONS.filter(function (action) {
        return actions.indexOf(action.id) >= 0;
      });

      function runAction(action) {
        const current = selectionRef.current;
        if (current === null) return;
        if (action.id === "copy") {
          copyText(current.text).then(function (ok) {
            showToast(ok ? "已复制" : "复制失败");
          });
          return;
        }
        if (action.id === "search") {
          const opened = openSearch(current.text);
          if (!opened) {
            copyText(current.text).then(function (ok) {
              showToast(ok ? "已复制，去搜索引擎粘贴" : "打开搜索失败");
            });
            return;
          }
          showToast("已在浏览器打开");
          return;
        }
        if (action.id === "save") {
          store.record(current.text, current.source, { favorite: true });
          showToast("已收进划词本");
          return;
        }
        setResult({ mode: action.id, status: "loading", text: "" });
        askHost(action.id, current.text)
          .then(function (text) {
            setResult({ mode: action.id, status: "done", text: text });
          })
          .catch(function (error) {
            setResult({ mode: action.id, status: "error", text: error && error.message ? error.message : "请求失败" });
          });
      }

      function resultNode() {
        if (result === null) return null;
        const title = result.mode === "translate" ? "译文" : "解释";
        const body =
          result.status === "loading"
            ? h("div", { className: "wh-result-loading" }, "思考中…")
            : result.status === "error"
              ? h("div", { className: "wh-result-error" }, result.text)
              : h("div", { className: "wh-result-text" }, result.text);
        return h(
          "div",
          { className: "wh-card-result", "data-dsh-wordhelper-ui": "1", key: "result" },
          h(
            "div",
            { className: "wh-result-head" },
            h("span", null, title),
            h(
              "button",
              {
                type: "button",
                className: "wh-icon",
                title: "关闭",
                "aria-label": "关闭",
                onMouseDown: function (event) {
                  event.preventDefault();
                },
                onClick: function () {
                  setResult(null);
                }
              },
              "✕"
            )
          ),
          body,
          result.status === "done"
            ? h(
                "div",
                { className: "wh-result-foot" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "wh-ghost",
                    onMouseDown: function (event) {
                      event.preventDefault();
                    },
                    onClick: function () {
                      copyText(result.text).then(function (ok) {
                        showToast(ok ? "已复制" : "复制失败");
                      });
                    }
                  },
                  "复制"
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "wh-ghost",
                    title: "把这段文字模拟输入到上一个窗口",
                    onMouseDown: function (event) {
                      event.preventDefault();
                    },
                    onClick: function () {
                      showToast("正在打回上一个窗口…");
                      typeIntoWindow(result.text, { target: "previous" })
                        .then(function (outcome) {
                          if (outcome.ok === true) showToast("已模拟输入到上一个窗口");
                          else showToast(outcome.message || "模拟输入失败");
                        })
                        .catch(function (error) {
                          showToast(error && error.message ? error.message : "模拟输入失败");
                        });
                    }
                  },
                  "打回窗口"
                ),
                h(
                  "button",
                  {
                    type: "button",
                    className: "wh-ghost",
                    onMouseDown: function (event) {
                      event.preventDefault();
                    },
                    onClick: function () {
                      store.record(selectionRef.current.text, selectionRef.current.source, { favorite: true });
                      showToast("已收进划词本");
                    }
                  },
                  "收藏"
                )
              )
            : null
        );
      }

      const bar = h(
        "div",
        { className: "wh-bar", "data-dsh-wordhelper-ui": "1", key: "bar" },
        visibleActions.map(function (action) {
          const needsModel = action.id === "translate" || action.id === "explain";
          const disabled = needsModel && host.checked === true && host.available === false;
          let icon = null;
          if (action.id === "translate") icon = h(TranslateIcon, null);
          else if (action.id === "explain") icon = h(ExplainIcon, null);
          else if (action.id === "copy") icon = h(CopyIcon, null);
          else if (action.id === "search") icon = h(SearchIcon, null);
          else icon = h(StarIcon, null);
          return h(
            "button",
            {
              key: action.id,
              type: "button",
              className: "wh-tab",
              title: disabled ? "宿主没有可用的默认模型" : action.hint,
              "aria-label": action.hint,
              disabled: disabled,
              onMouseDown: function (event) {
                event.preventDefault();
              },
              onClick: function () {
                runAction(action);
              }
            },
            icon,
            h("span", null, action.label)
          );
        }),
        visibleActions.length === 0
          ? h("span", { className: "wh-tab", style: { cursor: "default" } }, "未启用动作")
          : null
      );

      const rect = selection.rect;
      const viewportWidth = typeof window === "undefined" ? 1024 : window.innerWidth;
      const viewportHeight = typeof window === "undefined" ? 768 : window.innerHeight;
      const width = boxSize.width > 0 ? boxSize.width : 280;
      const height = boxSize.height > 0 ? boxSize.height : 36;
      const half = width / 2;
      const center = rect.left + rect.width / 2;
      const left = clamp(center, half + 8, Math.max(half + 8, viewportWidth - half - 8));
      // 上方空间不够（或浮条太高）就翻到下方，别顶出屏幕。
      const placeAbove = rect.top > height + 24 && rect.top > 116;
      const position = placeAbove
        ? { left: left, bottom: Math.max(8, viewportHeight - rect.top + 8) }
        : { left: left, top: clamp(rect.bottom + 8, 8, Math.max(8, viewportHeight - height - 8)) };
      const children = placeAbove ? [resultNode(), bar] : [bar, resultNode()];

      const floater = h(
        "div",
        {
          className: "wh-floater",
          style: position,
          ref: boxRef,
          "data-dsh-wordhelper-ui": "1"
        },
        children.filter(function (node) {
          return node !== null;
        }),
        toast === null ? null : h("div", { className: "wh-toast", key: "toast" }, toast)
      );

      // 挂到 body 上，避开主框架的 transform / overflow 裁剪。
      const portal = typeof document === "undefined" ? null : getPortalHost();
      if (portal === null || typeof ReactDOM.createPortal !== "function") return floater;
      return ReactDOM.createPortal(floater, portal);
    }

    // #endregion

    // #region 划词本主面板

    function Switch(props) {
      return h("button", {
        type: "button",
        className: "wh-switch",
        role: "switch",
        "aria-checked": props.checked === true ? "true" : "false",
        "aria-label": props.label,
        "data-on": props.checked === true ? "true" : "false",
        onClick: function () {
          props.onChange(!(props.checked === true));
        }
      });
    }

    function WordHelperPanel(props) {
      const store = props.store;
      const askHost = props.askHost;
      const onClose = props.onClose;
      const settings = useStore(store, function (state) {
        return state.settings;
      });
      const entries = useStore(store, function (state) {
        return state.entries;
      });
      const host = useStore(store, function (state) {
        return state.host;
      });
      const desktop = useStore(store, function (state) {
        return state.desktop;
      });

      const [query, setQuery] = React.useState("");
      const [filter, setFilter] = React.useState("all");
      const [expandedId, setExpandedId] = React.useState(null);
      const [rowResults, setRowResults] = React.useState({});
      const [toast, setToast] = React.useState(null);
      const [confirmClear, setConfirmClear] = React.useState(false);
      const timers = React.useRef({ toast: 0, confirm: 0 });

      React.useEffect(function () {
        probeHost(store);
        let cancelled = false;

        const pull = function () {
          fetchDesktopState()
            .then(function (payload) {
              if (cancelled === true) return;
              store.setDesktop({
                checked: true,
                supported: payload.supported === true,
                enabled: payload.enabled === true,
                running: payload.running === true,
                error: typeof payload.error === "string" ? payload.error : null,
                focus: payload.focus !== null && typeof payload.focus === "object" ? payload.focus : null
              });
              store.ingestDesktop(payload);
            })
            .catch(function () {
              if (cancelled === true) return;
              store.setDesktop({ checked: true, supported: false });
            });
        };

        pull();
        const timer = window.setInterval(pull, 4000);
        return function () {
          cancelled = true;
          window.clearInterval(timer);
          if (timers.current.toast !== 0) window.clearTimeout(timers.current.toast);
          if (timers.current.confirm !== 0) window.clearTimeout(timers.current.confirm);
        };
      }, [store]);

      function toggleDesktop(next) {
        setDesktopEnabled(next)
          .then(function (payload) {
            store.setDesktop({
              checked: true,
              supported: payload.supported === true,
              enabled: payload.enabled === true,
              running: payload.running === true,
              error: typeof payload.error === "string" ? payload.error : null,
              focus: payload.focus !== null && typeof payload.focus === "object" ? payload.focus : null
            });
            showToast(next === true ? "已开始监听全电脑复制" : "已停止监听");
          })
          .catch(function (error) {
            showToast(error && error.message ? error.message : "切换失败");
          });
      }

      function typeInto(entry) {
        showToast("正在打回上一个窗口…");
        typeIntoWindow(entry.text, { target: "previous" })
          .then(function (result) {
            if (result.ok === true) showToast("已模拟输入到上一个窗口");
            else showToast(result.message || "模拟输入失败");
          })
          .catch(function (error) {
            showToast(error && error.message ? error.message : "模拟输入失败");
          });
      }

      function showToast(message) {
        setToast(message);
        if (timers.current.toast !== 0) window.clearTimeout(timers.current.toast);
        timers.current.toast = window.setTimeout(function () {
          setToast(null);
          timers.current.toast = 0;
        }, 1500);
      }

      const keyword = query.trim().toLowerCase();
      const visible = entries.filter(function (entry) {
        if (filter === "favorite" && entry.favorite !== true) return false;
        if (keyword === "") return true;
        return entry.text.toLowerCase().indexOf(keyword) >= 0 || entry.source.toLowerCase().indexOf(keyword) >= 0;
      });

      function requestClear() {
        if (confirmClear !== true) {
          setConfirmClear(true);
          if (timers.current.confirm !== 0) window.clearTimeout(timers.current.confirm);
          timers.current.confirm = window.setTimeout(function () {
            setConfirmClear(false);
            timers.current.confirm = 0;
          }, 3200);
          return;
        }
        store.clear();
        setConfirmClear(false);
        showToast("划词本已清空");
      }

      function runRowAction(entry, mode) {
        setRowResults(function (previous) {
          return Object.assign({}, previous, { [entry.id]: { mode: mode, status: "loading", text: "" } });
        });
        askHost(mode, entry.text)
          .then(function (text) {
            setRowResults(function (previous) {
              return Object.assign({}, previous, { [entry.id]: { mode: mode, status: "done", text: text } });
            });
          })
          .catch(function (error) {
            setRowResults(function (previous) {
              return Object.assign({}, previous, {
                [entry.id]: { mode: mode, status: "error", text: error && error.message ? error.message : "请求失败" }
              });
            });
          });
      }

      const modelText = host.checked !== true ? "检查中…" : host.available === true ? "已连接 " + (host.model || "") + (host.provider ? "（" + host.provider + "）" : "") : "未连接";

      const settingsCard = h(
        "section",
        { className: "wh-card" },
        h(
          "div",
          { className: "wh-row" },
          h(
            "div",
            { className: "wh-row-text" },
            h("div", { className: "wh-row-label" }, "划词浮条"),
            h("div", { className: "wh-row-desc" }, "选中文字时，在旁边弹出翻译 / 解释 / 复制 / 搜索 / 收藏。")
          ),
          h(Switch, {
            label: "划词浮条",
            checked: settings.enabled,
            onChange: function (next) {
              store.setSettings({ enabled: next });
            }
          })
        ),
        h(
          "div",
          { className: "wh-row" },
          h(
            "div",
            { className: "wh-row-text" },
            h("div", { className: "wh-row-label" }, "自动记录划词历史"),
            h("div", { className: "wh-row-desc" }, "每次划词自动进划词本（最多 " + MAX_ENTRIES + " 条），只存在本机浏览器。")
          ),
          h(Switch, {
            label: "自动记录划词历史",
            checked: settings.recordHistory,
            onChange: function (next) {
              store.setSettings({ recordHistory: next });
            }
          })
        ),
        h(
          "div",
          { className: "wh-row" },
          h(
            "div",
            { className: "wh-row-text" },
            h("div", { className: "wh-row-label" }, "最短选中长度"),
            h("div", { className: "wh-row-desc" }, "少于这个长度的选区不弹浮条。")
          ),
          h(
            "div",
            { className: "wh-seg", role: "group", "aria-label": "最短选中长度" },
            MIN_LENGTH_OPTIONS.map(function (option) {
              return h(
                "button",
                {
                  key: option.value,
                  type: "button",
                  "data-on": settings.minLength === option.value ? "true" : "false",
                  onClick: function () {
                    store.setSettings({ minLength: option.value });
                  }
                },
                option.label
              );
            })
          )
        ),
        h(
          "div",
          { className: "wh-row" },
          h(
            "div",
            { className: "wh-row-text" },
            h("div", { className: "wh-row-label" }, "浮条动作"),
            h("div", { className: "wh-row-desc" }, "点一下开或关；翻译 / 解释需要宿主有可用模型。")
          ),
          h(
            "div",
            { className: "wh-chips", role: "group", "aria-label": "浮条动作" },
            ACTIONS.map(function (action) {
              const on = settings.actions.indexOf(action.id) >= 0;
              return h(
                "button",
                {
                  key: action.id,
                  type: "button",
                  className: "wh-chip",
                  "data-on": on ? "true" : "false",
                  title: action.hint,
                  onClick: function () {
                    store.toggleAction(action.id);
                  }
                },
                action.label
              );
            })
          )
        ),
        h(
          "div",
          { className: "wh-row" },
          h(
            "div",
            { className: "wh-row-text" },
            h("div", { className: "wh-row-label" }, "模型"),
            h("div", { className: "wh-row-desc" }, modelText)
          ),
          h(
            "button",
            {
              type: "button",
              className: "wh-ghost",
              onClick: function () {
                hostProbe = null;
                store.setHost({ checked: false, available: false, provider: null, model: null });
                probeHost(store);
              }
            },
            "重新检测"
          )
        )
      );

      const desktopStatus =
        desktop.checked !== true
          ? "检查中…"
          : desktop.supported !== true
            ? "当前系统不支持（仅 Windows 可用）"
            : desktop.error !== null && desktop.error !== ""
              ? "异常：" + desktop.error
              : desktop.enabled !== true
                ? "已关闭：不会读取系统剪贴板"
                : desktop.running === true
                  ? "监听中：任何程序里复制，都会进划词本"
                  : "正在启动…";

      const desktopCard = h(
        "section",
        { className: "wh-card" },
        h(
          "div",
          { className: "wh-row" },
          h(
            "div",
            { className: "wh-row-text" },
            h("div", { className: "wh-row-label" }, "全电脑划词"),
            h("div", { className: "wh-row-desc" }, "打开后，在任何程序里 Ctrl+C，文字都会进划词本（只在本机内存里）。"),
            h("div", { className: "wh-row-desc" }, desktopStatus)
          ),
          h(Switch, {
            label: "全电脑划词",
            checked: desktop.enabled === true,
            onChange: toggleDesktop
          })
        ),
        h(
          "div",
          { className: "wh-row" },
          h(
            "div",
            { className: "wh-row-text" },
            h("div", { className: "wh-row-label" }, "模拟输入"),
            h(
              "div",
              { className: "wh-row-desc" },
              desktop.focus !== null && desktop.focus !== undefined && desktop.focus.title
                ? "打回窗口：" + String(desktop.focus.title).slice(0, 60)
                : "还没记住上一个外部窗口；先去别的程序点一下，再回来。"
            ),
            h("div", { className: "wh-row-desc" }, "点条目上的「打回窗口」：文字先进剪贴板，切回上一个窗口再模拟一次 Ctrl+V。")
          )
        )
      );

      const listCard = h(
        "section",
        { style: { display: "flex", flexDirection: "column", gap: "12px" } },
        h(
          "div",
          { className: "wh-listhead" },
          h(
            "div",
            { className: "wh-search" },
            h(SearchIcon, { size: 14 }),
            h("input", {
              type: "search",
              value: query,
              placeholder: "搜索划词本",
              "aria-label": "搜索划词本",
              onChange: function (event) {
                setQuery(event.target.value);
              }
            })
          ),
          h(
            "div",
            { className: "wh-seg", role: "group", "aria-label": "筛选" },
            h(
              "button",
              {
                type: "button",
                "data-on": filter === "all" ? "true" : "false",
                onClick: function () {
                  setFilter("all");
                }
              },
              "全部"
            ),
            h(
              "button",
              {
                type: "button",
                "data-on": filter === "favorite" ? "true" : "false",
                onClick: function () {
                  setFilter("favorite");
                }
              },
              "已收藏"
            )
          ),
          h("span", { className: "wh-count" }, visible.length + " / " + entries.length + " 条"),
          h(
            "button",
            {
              type: "button",
              className: "wh-ghost",
              disabled: entries.length === 0,
              onClick: requestClear
            },
            confirmClear ? "确认清空？" : "清空"
          )
        ),
        visible.length === 0
          ? h(
              "div",
              { className: "wh-empty" },
              h(PanelIcon, { size: 28 }),
              h("div", null, entries.length === 0 ? "还没有划词记录" : "没有匹配的记录"),
              h("div", { className: "wh-hint" }, entries.length === 0 ? "在会话里选中一段文字，浮条右上角的「收藏」会把它留在这里。" : "换个关键词或切回「全部」看看。")
            )
          : h(
              "div",
              { className: "wh-entries" },
              visible.map(function (entry) {
                const isExpanded = expandedId === entry.id;
                const rowResult = rowResults[entry.id];
                return h(
                  "article",
                  {
                    key: entry.id,
                    className: "wh-entry",
                    "data-expanded": isExpanded ? "true" : "false"
                  },
                  h(
                    "div",
                    {
                      className: "wh-entry-main",
                      onClick: function () {
                        setExpandedId(isExpanded ? null : entry.id);
                      },
                      title: isExpanded ? "收起" : "展开全文"
                    },
                    h("div", { className: "wh-entry-text" }, entry.text),
                    h(
                      "div",
                      { className: "wh-entry-meta" },
                      h("span", null, formatTime(entry.createdAt)),
                      entry.source !== "" ? h("span", null, "· " + entry.source) : null,
                      entry.favorite === true ? h("span", null, "· 已收藏") : null
                    )
                  ),
                  h(
                    "div",
                    { className: "wh-entry-actions" },
                    desktop.supported === true
                      ? h(
                          "button",
                          {
                            type: "button",
                            className: "wh-icon",
                            title: "模拟输入到上一个窗口",
                            "aria-label": "模拟输入到上一个窗口",
                            onClick: function () {
                              typeInto(entry);
                            }
                          },
                          h(SendIcon, { size: 15 })
                        )
                      : null,
                    host.available === true
                      ? h(
                          "button",
                          {
                            type: "button",
                            className: "wh-icon",
                            title: "翻译",
                            "aria-label": "翻译",
                            onClick: function () {
                              runRowAction(entry, "translate");
                            }
                          },
                          h(TranslateIcon, { size: 15 })
                        )
                      : null,
                    host.available === true
                      ? h(
                          "button",
                          {
                            type: "button",
                            className: "wh-icon",
                            title: "解释",
                            "aria-label": "解释",
                            onClick: function () {
                              runRowAction(entry, "explain");
                            }
                          },
                          h(ExplainIcon, { size: 15 })
                        )
                      : null,
                    h(
                      "button",
                      {
                        type: "button",
                        className: "wh-icon",
                        title: entry.favorite === true ? "取消收藏" : "收藏",
                        "aria-label": entry.favorite === true ? "取消收藏" : "收藏",
                        "data-on": entry.favorite === true ? "true" : "false",
                        onClick: function () {
                          store.toggleFavorite(entry.id);
                        }
                      },
                      h(StarIcon, { size: 15, filled: entry.favorite === true })
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "wh-icon",
                        title: "复制",
                        "aria-label": "复制",
                        onClick: function () {
                          copyText(entry.text).then(function (ok) {
                            showToast(ok ? "已复制" : "复制失败");
                          });
                        }
                      },
                      h(CopyIcon, { size: 15 })
                    ),
                    h(
                      "button",
                      {
                        type: "button",
                        className: "wh-icon",
                        title: "删除",
                        "aria-label": "删除",
                        "data-danger": "true",
                        onClick: function () {
                          store.remove(entry.id);
                        }
                      },
                      h(TrashIcon, { size: 15 })
                    )
                  ),
                  rowResult === undefined
                    ? null
                    : h(
                        "div",
                        { style: { flexBasis: "100%" } },
                        h(
                          "div",
                          { className: "wh-entry-result" },
                          rowResult.status === "loading"
                            ? "思考中…"
                            : rowResult.status === "error"
                              ? "⚠ " + rowResult.text
                              : rowResult.text
                        )
                      )
                );
              })
            )
      );

      return h(
        "div",
        { className: "wh-panel", "data-dsh-wordhelper-ui": "1" },
        h(
          "header",
          { className: "wh-head" },
          h(
            "div",
            null,
            h("h1", { className: "wh-title" }, "划词助手"),
            h("p", { className: "wh-sub" }, "选中文字就会弹出浮条；Ctrl+C 复制也一样。翻译、解释、复制、搜索、收藏都在手边。")
          ),
          h(
            "div",
            { style: { display: "flex", gap: "8px", flex: "0 0 auto" } },
            h(
              "button",
              {
                type: "button",
                className: "wh-ghost",
                title: "在屏幕中间演示一次浮条，确认它能不能弹出来",
                onClick: function () {
                  store.showPreview();
                }
              },
              "预览浮条"
            ),
            onClose === null
              ? null
              : h(
                  "button",
                  {
                    type: "button",
                    className: "wh-ghost",
                    onClick: function () {
                      onClose();
                    }
                  },
                  h(BackIcon, { size: 14 }),
                  "回到会话"
                )
          )
        ),
        settingsCard,
        desktopCard,
        listCard,
        h(
          "p",
          { className: "wh-hint", style: { textAlign: "center" } },
          "划词记录只保存在本机浏览器；翻译与解释由宿主当前的默认模型完成。"
        ),
        toast === null ? null : h("div", { className: "wh-toast", style: { position: "fixed", bottom: "24px" } }, toast)
      );
    }

    // #endregion

    // #region 插件入口

    /** 只需要 slot 注册表；布局 / 侧栏 / 浮层由槽声明方提供。 */
    const inject = ["slots"];

    function apply(ctx) {
      ensureStyle();

      const store = createStore();
      const layout = typeof ctx.get === "function" ? ctx.get("layout") : undefined;
      const onClose =
        layout !== undefined && layout !== null && typeof layout.selectPanel === "function"
          ? function () {
              try {
                layout.selectPanel(null);
              } catch (error) {
                console.warn("dsh-wordhelper: 返回会话失败", error);
              }
            }
          : null;

      ctx.effect(function () {
        return ctx.slots.inject("sidebar.panellist", function () {
          return ctx.slots.register(
            {
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: SIDEBAR_ORDER,
              label: "划词助手"
            },
            PanelIcon
          );
        });
      }, "dsh-wordhelper: 左栏入口");

      ctx.effect(function () {
        return ctx.slots.inject("main", function () {
          return ctx.slots.register(
            {
              name: "main",
              key: PANEL_ID,
              inject: function () {
                return { store: store, askHost: askHost, onClose: onClose };
              }
            },
            WordHelperPanel
          );
        });
      }, "dsh-wordhelper: 划词本面板");

      ctx.effect(function () {
        return ctx.slots.inject("shell.overlay", function () {
          return ctx.slots.register(
            {
              name: "shell.overlay",
              id: "wordhelper.selection",
              inject: function () {
                return { store: store, askHost: askHost };
              }
            },
            SelectionToolbar
          );
        });
      }, "dsh-wordhelper: 划词浮条");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
