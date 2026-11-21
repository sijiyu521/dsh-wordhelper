/**
 * 划词浮条的 DOM 行为测试（jsdom + react-dom/client）。
 *
 * 覆盖三件事：
 *   1. 没有选区时什么都不渲染；
 *   2. 面板「预览浮条」能让浮条出现，且它是 portal 到 document.body 的；
 *   3. 真的选中文字 + pointerup 之后，浮条带着所有启用动作出现。
 *
 * 注意：react-dom 必须在把 jsdom 的 window/document 装成全局之后才加载，
 * 否则它会在模块初始化时抓到没有 DOM 的全局。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = process.cwd();
const testenv = path.join(root, ".tmp", "testenv", "node_modules");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { JSDOM } = await import(pathToFileURL(path.join(testenv, "jsdom", "lib", "api.js")).href);

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://127.0.0.1:58084/",
  runScripts: "outside-only",
  pretendToBeVisual: true
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = false;

// jsdom 没有 fetch：给一个总是 404 的桩，让插件的能力探测走「不可用」分支。
dom.window.fetch = async () => ({
  ok: false,
  status: 404,
  json: async () => null,
  text: async () => ""
});

const React = (await import(pathToFileURL(path.join(testenv, "react", "index.js")).href)).default;
const ReactDOM = await import(pathToFileURL(path.join(testenv, "react-dom", "client.js")).href);
const ReactDOMPortal = await import(pathToFileURL(path.join(testenv, "react-dom", "index.js")).href);

/** 把插件 bundle 当经典脚本跑进 jsdom 的上下文，取出 apply。 */
function loadPlugin() {
  const code = fs.readFileSync(path.join(root, "lib", "client.js"), "utf8");
  let captured = null;
  dom.window.__ModuleLoader__ = {
    load(entry) {
      captured = entry;
    }
  };
  vm.runInContext(code, dom.getInternalVMContext(), { filename: "client.js" });
  assert.ok(captured !== null, "bundle 应该调用 window.__ModuleLoader__.load");
  assert.equal(captured.id, "dsh-wordhelper");

  const requireStub = (id) => {
    if (id === "react") return React;
    if (id === "react-dom") return ReactDOMPortal;
    throw new Error("bundle 引用了基座外的模块: " + id);
  };
  return captured.factory(requireStub);
}

/** 造一个只收集注册的假客户端 ctx。 */
function applyPlugin(exportsObj) {
  const registrations = [];
  const ctx = {
    get: () => undefined,
    effect: (fn) => {
      const dispose = fn();
      return () => {
        if (typeof dispose === "function") dispose();
      };
    },
    slots: {
      inject: (name, fn) => fn(),
      register: (opts, Comp) => {
        registrations.push({ opts, Comp });
        return () => {};
      }
    },
    logger: { info() {}, warn() {} }
  };
  exportsObj.apply(ctx);
  return registrations;
}

/** 造一个带 rect 的选区。 */
function selectText(text, rect) {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  document.body.appendChild(paragraph);
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  range.getBoundingClientRect = () => rect;
  const selection = dom.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  return paragraph;
}

test("划词浮条：注册齐全、预览与真实划选都能弹到 body 上", async () => {
  const exportsObj = loadPlugin();
  assert.equal(typeof exportsObj.apply, "function");
  assert.ok(Array.isArray(exportsObj.inject));

  const registrations = applyPlugin(exportsObj);
  const names = registrations.map((r) => r.opts.name);
  assert.deepEqual(names.sort(), ["main", "shell.overlay", "sidebar.panellist"].sort());

  const toolbarReg = registrations.find((r) => r.opts.name === "shell.overlay");
  const injected = toolbarReg.opts.inject();
  assert.ok(injected.store, "浮条需要 store");
  assert.equal(typeof injected.askHost, "function");

  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const reactRoot = ReactDOM.createRoot(mount);
  reactRoot.render(React.createElement(toolbarReg.Comp, { size: 16, active: false, ...injected }));
  await wait(60);

  // 1) 没有选区 → 什么都不渲染
  assert.equal(document.querySelector(".wh-bar"), null, "没选区时不应该有浮条");

  // 2) 预览浮条
  injected.store.showPreview();
  await wait(80);
  const previewBar = document.querySelector(".wh-bar");
  assert.ok(previewBar, "预览浮条应该出现");
  const floater = document.querySelector(".wh-floater");
  assert.ok(floater, "应该有浮条容器");
  const portalHost = floater.closest("[data-dsh-wordhelper-portal]");
  assert.ok(portalHost, "浮条必须 portal 到 body 上的容器，不能留在 shell.overlay 里");
  assert.equal(portalHost.parentElement, document.body, "portal 容器应该直接挂 body");
  const actionLabels = [...document.querySelectorAll(".wh-tab")].map((node) => node.textContent);
  for (const label of ["翻译", "解释", "复制", "搜索", "收藏"]) {
    assert.ok(actionLabels.some((value) => value.includes(label)), `浮条应该包含动作：${label}`);
  }

  // 3) 点空白处收起
  document.body.dispatchEvent(new dom.window.Event("mousedown", { bubbles: true }));
  await wait(40);
  assert.equal(document.querySelector(".wh-bar"), null, "点空白处应该收起浮条");

  // 4) 真实划选 + pointerup
  const paragraph = selectText("选中我试试看", { left: 200, top: 300, width: 160, height: 20, right: 360, bottom: 320 });
  paragraph.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  await wait(80);
  const realBar = document.querySelector(".wh-bar");
  assert.ok(realBar, "划选之后浮条应该弹出来");
  const style = document.querySelector(".wh-floater").getAttribute("style") ?? "";
  assert.match(style, /left:\s*\d/, "浮条应该带计算出来的 left");

  reactRoot.unmount();
  await wait(20);
});
