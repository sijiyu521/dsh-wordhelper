# dsh-wordhelper · 划词助手

DSH 的划词助手插件：**左边栏一个入口 + 划词浮条 + 全电脑剪贴板监听 + 模拟输入**。

选中文字就能翻译 / 解释 / 复制 / 搜索 / 收藏；在别的程序里复制，也能收进划词本，
再「打回」到上一个窗口。

---

## 功能

| 位置 | 能力 |
| --- | --- |
| 左侧栏「划词助手」入口 | 打开划词本主面板 |
| 划词浮条 | 选中文字（或按 <kbd>Ctrl</kbd>+<kbd>C</kbd>）自动弹出：翻译 / 解释 / 复制 / 搜索 / 收藏 |
| 翻译 / 解释 | 走宿主当前的默认模型（`ctx.llm` + `ctx.agentDefaultModel`），结果显示在浮条小卡片里 |
| 划词本 | 历史记录、收藏、搜索、复制、删除、清空；自动去重，最多 200 条 |
| 全电脑划词 | 打开后常驻监听 Windows 系统剪贴板，任何程序里的复制都会进划词本（带来源窗口名） |
| 模拟输入 | 把某条文字放进剪贴板 → 切回上一个外部窗口 → 自动模拟 <kbd>Ctrl</kbd>+<kbd>V</kbd> |

面板里可以逐项开关、调整最短选中长度、选择浮条上出现哪些按钮。

---

## 安装

本地开发（link 到 profile）：

```powershell
dsh plugin --profile desktop add link:C:\Users\Jack\git\dsh-wordhelper
```

或在 DSH 会话里让插件管理器装 `link:` 规格。装完需要**重启宿主**让宿主侧代码生效；
浏览器侧 bundle 变更由 client-modules 按 revision 自动重载。

---

## 使用

### 1. 页面内划词

选中任何文字 → 浮条出现在选区上方（或下方）。
也可以直接按 <kbd>Ctrl</kbd>+<kbd>C</kbd>：复制的同时浮条会出来。
浮条、面板内部的选中不会触发浮条。

浮条挂在 `document.body` 的 portal 里（不受主框架 transform / overflow 影响）；
选区量不出坐标时会退回鼠标位置。面板右上角的「预览浮条」可以让它在屏幕中间演示一次，
用来确认浮条本身能不能弹出来。

### 2. 全电脑划词

打开「划词助手」面板 → 「全电脑划词」开关打开。
之后在任意程序里 <kbd>Ctrl</kbd>+<kbd>C</kbd>，文字会进划词本，来源显示成
`剪贴板 · 应用窗口标题`。捕获只在宿主内存里，最多 40 条，关闭开关即停止。

### 3. 模拟输入（打回窗口）

在划词本里点某条右侧的「打回窗口」（或浮条翻译结果里的同名按钮）：

1. 文字先进系统剪贴板；
2. 宿主把上一个外部窗口切回前台（先试直接切，再试线程挂接，最后用 ALT 触发前台锁豁免）；
3. 确认前台不是 DSH 自己，再模拟一次 <kbd>Ctrl</kbd>+<kbd>V</kbd>。

切不回去或前台仍是 DSH 时**不会发送按键**，只把文字留在剪贴板，并给出提示。

---

## 数据与隐私

- 划词本与设置存在**浏览器 localStorage**（键 `dsh-wordhelper:v2`）。
- 系统剪贴板捕获只在**宿主内存**里，最多 40 条，宿主重启即清空。
- 「全电脑划词」默认关闭，开关状态记在 `$DSH_HOME/wordhelper/desktop.json`（只有布尔值）。
- 翻译 / 解释会把选中文字发给**宿主当前配置的默认模型**，除此之外不外发任何内容。

---

## 结构

```
package.json          # dsh.bundle.patch + dsh.client(platform: web) 声明
cordis.patch.yml      # 把插件插进 profile 配置树
lib/
  index.js            # 宿主入口：延迟加载两套能力，各自兜底
  host/
    lookup.js         # /api/wordhelper/health + /api/wordhelper/lookup（默认模型翻译/解释）
    prompts.js        # 请求归一化与提示词
    desktop.js        # 桌面联动桥：剪贴板监听子进程、模拟输入、/api/wordhelper/desktop
    scripts.js        # 上面两个模块用的 PowerShell 脚本（监听 / 粘贴）
  client.js           # 浏览器侧：经典脚本 + 懒 CJS 工厂，注册三个 slot
test/                 # node:test 单测与客户端冒烟测试
```

### 浏览器侧注册点

| slot | 用途 |
| --- | --- |
| `sidebar.panellist`（list） | 左侧栏入口图标，`id = "wordhelper"` |
| `main`（keyed，`key = "wordhelper"`） | 划词本主面板 |
| `shell.overlay`（list） | 全局划词浮条 |

### 宿主 `/api` 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/wordhelper/health` | 是否拿到默认模型 |
| POST | `/api/wordhelper/lookup` | `{ mode: "translate" \| "explain", text }` |
| GET | `/api/wordhelper/desktop` | 监听状态、最近捕获、上一个外部窗口 |
| POST | `/api/wordhelper/desktop` | `{ enabled }` 或 `{ action: "paste" \| "copy", text, target?, delayMs? }` |

全部注册在 client-connection 的 `/api` 通道上，浏览器认证与 Host/Origin 校验由通道负责，
路由侧只做参数校验与错误归一化。

---

## 开发与测试

```powershell
node --test test/            # 宿主侧单测 + 客户端冒烟测试
node .tmp/self-check.mjs     # 手工自检：bundle 物化、三处注册、无 DOM 渲染
node .tmp/desktop-e2e.mjs    # 桌面联动端到端：剪贴板捕获 + 模拟输入到独立小窗口
```

`.tmp/` 下还留着开发期的解包文档与实验脚本，不随包发布。

---

## 已知限制

- **模拟输入只在 Windows 可用**（依赖 PowerShell 5.1 + Win32）。其它平台开关会显示「不支持」，其余功能照常。
- 插件跑在 DSH 宿主进程里，**做不了系统级悬浮窗**；「在电脑任何地方使用」是通过剪贴板监听 + 打回窗口实现的。
- 宿主侧代码改动需要重启宿主；浏览器侧 bundle 改动会按 revision 自动重载。
- 翻译 / 解释的质量与可用性取决于当前默认模型。
