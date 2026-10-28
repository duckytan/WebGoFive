# WebGoFive-H5-v2 交付进度

> 独立新项目，不复用 WebGoFive-H5-Qoder 旧代码。引擎复用 v1.4.0（171 测试背书），UI/核心/渲染器全部重写。
> 最后更新：2026-10-29 —— **v2.2.0（P2：高级棋力选项 + 开局定式推荐）开发完成，验收全绿，待用户确认发布**。

## 结论：✅ 开发完成，验收 PASS

- 单元测试 **218/218**（6 套件：engine 39 + forbidden 45 + vcf 28 + search 36 + loadorder 22 + tunable 48）
- E2E（真实 Edge）**93/93，10 套件**（含 10-strength-opening）
- 资源完整性（含 sw.js PRECACHE 清单）+ 版本一致性（2.2.0 四处源）通过
- 总判定 **PASS**，`reports/acceptance.json`，变更明细见 `CHANGELOG.md`

## v2.2.0（10-29）：P2 两项落地，PRD-AI-ENHANCE 需求池全部完成

硬约束延续：`js/engine/*` 与 `js/core/game.js` 零改动，全部增量在
`index.html`、`js/app/tunable-ai.js`（新）、`js/app/analysis.js`、`js/ui/app.js`。

1. **高级棋力选项（P2-5）**：地狱难度下暴露「搜索时间 / 深度 / 候选数」。
   新模块 `GMK.TunableAI`：`sanitize` 纯函数夹界（timeMs 100–10000 /
   depth 1–24 / candidates 4–64，防主线程搜死），`createWrapper` 产出满足
   GomokuAI 契约的包装 AI —— 非 HELL / 未自定义 / 等于默认时原样委托
   `engine.getMove`，HELL + 自定义参数走公开契约 `engine.getBestMove` 透传。
   App 启动即 `game.setAI(包装层)`（换 AI 契约的标准用法）；包装层内置
   **终局守卫**（`getBestMove` 内部换临时 game 会绕过核心终局判断）。
   参数持久化 localStorage（`gmk_strength_hell`），「恢复默认」一键清空。
2. **开局定式推荐（P2-6）**：`Analysis.openingRecommendation` —— 盘面
   < 4 子时按 `Evaluator.pointValue` 打分、同分取更靠中心者（中心性破平，
   空盘退化天元）；App 层 `_maybeOpeningRec()` 在开局窗口填面板
   「AI 推荐 / source=开局」并复用 P0 hint 渲染通道；PvP/PvE 生效，
   EvE/VCF 跳过，出窗自动恢复原 AI 诊断展示；newGame / undo 同步刷新。
3. **测试**：单元新增 `tunable` 48 项（清洗 / 委托透传 / 守卫 / 真实引擎
   端到端 / 开局推荐）；E2E 新套件 `10-strength-opening` 14 项；
   `09-ai-panel` ③ 改为出窗局面（前 4 手面板现显示开局推荐）。
4. **版本**：2.1.0 → 2.2.0 四处源同步；sw.js PRECACHE 增补
   `js/app/tunable-ai.js`；accept.js needFiles / unitSets 同步。

## 技术栈（按用户要求）

- **纯原生 JS（ES6）无构建**：Vercel 静态 / WorkBuddy 静态发布都直接吃
- **模块化 API**（`docs/API-CONTRACT.md`）：
  - 引擎 ↔ 核心：`ai.getMove(game, diff)`，核心不 new 具体 AI，`game.setAI(impl)` 注入
  - 核心 ↔ UI：`game.on(event, cb)` + 公开方法
  - 渲染器 ↔ UI：`renderer.render(board2d, opts)` + `renderer.on('click'|'hover')`
  - 换 UI 不碰引擎/核心；换 AI 不碰页面/核心
- 所有模块挂 `window.GMK.*`，浏览器直接 `<script>` 加载，Node 直接 `require` 测试

## 目录结构

```
WebGoFive-H5-v2/
├── index.html              # 语义化骨架 + PWA + 13 个 script 按 API-CONTRACT 顺序
├── manifest.webmanifest    # PWA manifest
├── sw.js                   # Service Worker（离线缓存）
├── package.json            # v2.0.0，scripts: dev/test/bench/selfplay/test:e2e/accept
├── LICENSE                 # MIT
├── js/
│   ├── engine/             # 引擎 7 文件（复用，171 测试背书）
│   │   ├── constants.js / board.js / evaluator.js
│   │   ├── search.js / kill.js / forbidden.js / gomoku-ai.js
│   ├── core/
│   │   └── game.js         # GomokuGame（状态机/规则/事件/AI 注入）
│   ├── renderer/
│   │   └── board.js        # BoardRenderer（DPR/主题/点击换算）
│   ├── ui/
│   │   └── app.js          # App（启动/模式/提示/快捷键/EvE 自动对战）
│   ├── app/
│   │   ├── save-load.js    # localStorage 自动存/读
│   │   ├── replay.js       # 回放器（步进/快进/跳步）
│   │   └── vcf.js          # VCF 冲四练习
│   └── ...
├── css/
│   ├── style.css           # 布局 + 响应式（390px）
│   ├── themes.css          # 主题调色板（wood/dark/light）
│   └── animations.css      # 动画 + 减弱动效
├── assets/                 # icon-192/512.png
├── tests/
│   ├── engine/             # 5 套引擎/装配测试（170 断言）
│   ├── e2e/                # harness + 8 套件 + run.js（56 断言）
│   └── accept.js           # 验收闸门
├── tools/
│   ├── serve.js            # 零依赖静态服务
│   └── gen-icons.js
└── docs/
    ├── API-CONTRACT.md     # 模块化契约（核心文档）
    └── ...
```

## 复现命令

```bash
cd D:/WorkBuddy/WebGoFive/WebGoFive-H5-v2
npm install             # 已装 puppeteer-core
npm start               # 本地预览 http://127.0.0.1:8080
npm run accept          # 一键完整验收（单元 + E2E + 资源 + 版本）
npm test                # 只跑 170 项单元
npm run test:e2e        # 只跑 79 项 E2E（9 套件）
npm run bench           # 性能基准
npm run selfplay        # 棋力自对弈（勿与 CPU 密集任务并行）
```

## 与旧项目 WebGoFive-H5-Qoder 的区别

| 维度 | 旧 Qoder | 新 v2 |
|---|---|---|
| 代码来源 | 旧代码上打 20 个补丁 | 全新独立项目，仅引擎复用 |
| 架构 | 单文件 2000+ 行 | 模块化 API-CONTRACT，三层解耦 |
| 构建 | 无 | 无（原生） |
| 单元 | 171 项 | 170 项（loadorder 重写 22 项） |
| E2E | 140 项（含旧代码场景） | 76 项 / 9 套件（只测 v2 功能） |
| 换 AI/UI | 改源码 | 按 API-CONTRACT 注入，不动引擎/核心 |


## 交互修复（22:52）：先落子后思考

玩家点完棋子后，AI 的同步搜索曾和落子渲染挤在同一个任务里，浏览器全程没机会上屏，
视觉上是「点了没反应，然后两颗子一起出现」。

- `js/ui/app.js` 新增 `_scheduleAIThink(delay)` / `_cancelAIThink()`：
  `requestAnimationFrame`（本帧绘制前）→ `setTimeout`（绘制后）两段让出，搜索才开跑；
  `aiThinking` 在排期瞬间置 true，兼作连点防抖。
- 新局 / 悔棋 / 棋盘 reset / 终局都会 `_cancelAIThink()`，杜绝排期中的一手补到新盘上。
- EvE 自动对局也走同一套排期（`_scheduleAIThink(60)`），不再有第二套 setTimeout 逻辑。
- `tests/e2e/suites/03-ai.js` 从 5 条扩到 12 条，用**画布像素**证明「点击后下一帧玩家棋子已画出、AI 未落子」。
- 验收：单元 170/170、E2E **76/76**、`accept.js` PASS。

## 版本号展示（23:06）

标题左侧新增版本徽标 `<span id="app-version">v2.0.0</span>`，样式走主题变量
（`--surface-2` 底 + `--text-dim` 字），wood / dark / light 三套主题都已截图确认可读。

**四个版本源现在由验收闸门统一盯着**（此前只有两个，且 manifest 那条是空检查）：

| 位置 | 作用 | 闸门校验 |
|---|---|---|
| `package.json` | 唯一真源 | version 非空 |
| `manifest.webmanifest` | PWA 元数据 | 与 package 相等 |
| `index.html` `#app-version` | 用户看到的徽标 | 与 `v` + package 相等 |
| `sw.js` `VERSION` | 离线缓存名 | 与 package 相等 |

顺带修正：`sw.js` 的 `VERSION` 原本还是 `1.4.0`（引擎版本残留），会让装了 PWA 的用户
继续吃旧缓存，已改为 `2.0.0`。
E2E `01-load` 新增 2 条断言（徽标文本 + 可见性），总计 **76/76**。

## AI 增强阶段（10-28 晚，PRD-AI-ENHANCE T1-T7 全部落地）

按 `docs/PRD-AI-ENHANCE.md` + `docs/AI-ENHANCE-DESIGN.md` 完成，硬约束
「`js/engine/*` 与 `js/core/game.js` 零 diff」已核验（与基线逐文件比对一致）：

- T1 `js/app/analysis.js`：`GMK.Analysis`（advantage / threatPoint / evaluate /
  scanOpponentThreat），只读消费 EngineAI / Evaluator / C / Kill。
- T2 `js/renderer/board.js`：`render` 新增 `opts.threat` 红色描边圈。
- T3 `index.html`：AI 分析面板 + VCF 面板 DOM，script 顺序按契约补 analysis.js。
- T4 `js/ui/app.js`：落子后刷新推荐/威胁/优势条，深度评估按钮，提示/威胁开关。
- T5 `js/app/vcf.js`：题库扩到 5 道（入门 2 / 进阶 2 / 中阶 1）。
- T6 `docs/API-CONTRACT.md`：补 `Evaluator` / `Analysis` 契约条目。
- T7 E2E `09-ai-panel.js` 套件并入 run.js。

## v2.1.0 收尾（10-29）：PWA 修复 + 交付文档

验收虽绿，复核发现 **PWA 离线缓存从未真正生效**，已修复并加闸门防复发：

1. `sw.js` 的 `PRECACHE` 还是旧项目（Qoder）的文件名 —— 12 个 404 文件让 install 的
   `cache.addAll` 整体拒绝，SW 永远装不上。E2E `08-pwa` 旧断言只看「注册状态可读」
   （返回 boolean 就过），没盯住。清单改为 v2 真实资源。
2. `assets/icon-maskable-512.png` 缺失（manifest 引用了它）—— 重跑 `tools/gen-icons.js` 补齐。
3. 加固：`accept.js` 新增「sw.js PRECACHE 清单文件都存在」闸门（needFiles 同时补
   analysis.js 与 maskable 图标）；E2E `08-pwa` 改为「SW 必须 active + 缓存逐项命中
   PRECACHE + 徽标与 manifest 版本一致」，76 → 79 项。
4. 版本 2.0.0 → **2.1.0**（四处源同步）；新增 `CHANGELOG.md`（2.0.0 + 2.1.0）与
   `README.md`（用户 + 开发双视角）。
5. 复跑 `npm run accept`：**PASS**（单元 170、E2E 79/79、问题 0）。
