# 更新日志

本项目的所有重要变更都记录在本文件中。
格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [2.2.0] - 2026-10-29

### 🚀 新增（PRD-AI-ENHANCE P2 两项，PRD 需求池至此全部落地）

- **高级棋力选项**（P2-5）：地狱难度下新增「高级强度」面板，可自定义
  搜索时间（100–10000ms）/ 深度（1–24 层）/ 候选数（4–64 个），
  一键恢复引擎默认；参数自动夹界取整（防主线程搜死触摸交互），
  经 `GMK.TunableAI` 包装 AI 走公开契约 `EngineAI.getBestMove` 透传，
  选择持久化到 localStorage，重开页面自动恢复。
  - 非 HELL 难度与「未自定义 / 等于默认」时原样委托引擎，行为与 v2.1 完全一致。
  - 包装层内置终局守卫（`getBestMove` 内部会换临时 game，绕过核心终局判断）。
- **开局定式推荐**（P2-6）：前 4 手内（盘面 < 4 子），分析面板自动给出
  当前行棋方的开局推荐点 —— 候选按 `Evaluator.pointValue` 打分、
  同分取更靠中心者（中心性破平）；棋盘复用「最优提示」渲染通道高亮；
  PvP / PvE 生效，EvE / VCF 练习自动跳过；出窗后恢复原有 AI 诊断展示。
  - 新增 `Analysis.openingRecommendation(board2d, player, opts)` 公开方法。

### 🔧 变更

- App 启动时自建 `EngineAI` 并注入 `GMK.TunableAI` 包装层（`game.setAI`，
  换 AI 契约的标准用法）；引擎诊断链路（`lastAIInfo`）不变。
- `sw.js` PRECACHE 清单新增 `js/app/tunable-ai.js`；`accept.js` 的
  `needFiles` 与单元套件清单同步。

### ✅ 质量

- 单元新增 `tunable` 套件 48 项（参数清洗 / 委托与透传 / 终局守卫 /
  真实引擎端到端 / 开局推荐），合计 218 项。
- E2E 新套件 `10-strength-opening` 14 项（面板可见性 / 透传持久化 /
  越界夹取 / 恢复默认 / HELL 自定义参数真实落子 / 开局推荐与出窗）；
  `09-ai-panel` ③ 改为出窗局面（前 4 手面板现显示开局推荐），共 10 套件。
- `js/engine/*` 与 `js/core/game.js` 保持零改动。

## [2.1.0] - 2026-10-29

### 🚀 新增（AI 功能增强，基于 PRD-AI-ENHANCE.md）

- **AI 分析面板**（PvP/PvE 显示，EvE 隐藏）：
  - 形势优势条：黑领先 / 白领先 / 均势，随每步刷新。
  - AI 推荐落点 + `source` 中文语义（搜索所得 / 算杀截断 / 防亏手），
    附深度 / 节点数 / 耗时诊断。
  - 主要变例列表（前 3 条，按分值降序）。
  - 「深度评估」按钮：可调 timeMs（默认 500ms 上限）/ 深度 / 候选数，
    计算期间显示加载遮罩，不卡触摸交互。
  - 「最优提示」开关：在棋盘上画出 AI 推荐点（黄色半透明）。
- **实时威胁提示**：对手下一手即可成五的点以红色描边圈高亮（PvP/PvE 均生效），
  「威胁提示」开关可关，终局自动清除。
- **VCF 冲四练习面板**：内置题库扩到 5 道（入门 2 / 进阶 2 / 中阶 1），
  支持选题 → 加载棋盘 → 求解校验 → 计时记录 → 历史最佳展示。
- 新模块 `GMK.Analysis`（`js/app/analysis.js`，App 层）：
  `advantage / threatPoint / evaluate / scanOpponentThreat` 四个公开方法，
  只读消费引擎公开 API；渲染器 `render` 新增 `opts.threat` 参数。
  **`js/engine/*` 与 `js/core/game.js` 零改动**（与基线 diff 为空）。
- E2E 新套件 `09-ai-panel`（共 9 套件）；`docs/API-CONTRACT.md` 补
  `Evaluator` / `Analysis` 契约条目。

### 🛠 修复

- **PWA 离线缓存从未生效**：`sw.js` 的 `PRECACHE` 清单仍是旧项目（Qoder）的
  文件名，12 个 404 文件让 `install` 的 `cache.addAll` 整体拒绝，SW 永远装不上。
  清单改为 v2 真实资源，并补齐缺失的 `icon-maskable-512.png`。
  - 闸门加固：`accept.js` 新增「sw.js PRECACHE 清单文件都存在」检查，
    `needFiles` 补 `js/app/analysis.js` 与 maskable 图标。
  - E2E `08-pwa` 加固：SW 必须真正 `active`（旧断言只看「状态可读」），
    逐项校验 PRECACHE 在当前版本缓存中命中，版本徽标与 manifest 一致。
- **AI 落子挤占渲染**：玩家落子后 AI 的同步搜索曾与渲染挤在同一任务，
  视觉上「点了没反应，然后两颗子一起出现」→ `requestAnimationFrame` +
  `setTimeout` 两段让出后再搜索；新局 / 悔棋 / 终局取消排期中的 AI 手，
  EvE 自动对局走同一排期。E2E `03-ai` 以画布像素证明渲染时序（12 项）。

### 🔧 变更

- 版本号 2.0.0 → 2.1.0，四处版本源（package / manifest / 徽标 / SW 缓存名）
  由验收闸门统一校验；`sw.js` 缓存名随版本更新，激活时清掉旧缓存。

## [2.0.0] - 2026-10-28

### 🚚 全新重构版（本版本主题：模块化重来，不打补丁）

- 独立新项目，不复用旧代码；引擎复用 v1.4.0（171 项测试背书），
  核心 / 渲染器 / UI 全部重写。
- 模块化三层架构（`docs/API-CONTRACT.md`）：
  - 引擎 ↔ 核心：`ai.getMove(game, diff)`，核心不 new 具体 AI，`game.setAI(impl)` 注入；
  - 核心 ↔ UI：`game.on(event, cb)` + 公开方法；
  - 渲染器 ↔ UI：`renderer.render(board2d, opts)` + `renderer.on('click'|'hover')`。
  换 UI 不碰引擎/核心；换 AI 不碰页面/核心。
- 纯原生 ES6 无构建：Vercel / 任意静态托管直接发布；所有模块挂 `window.GMK.*`，
  浏览器 `<script>` 加载、Node 直接 `require` 测试。
- 功能：人机 / 双人 / AI 对打三种模式，四档难度（入门/普通/困难/地狱），
  三套主题（木质/深色/浅色），棋盘坐标，回放器（步进/快进/跳步），
  localStorage 自动存档，快捷键（N 新游戏 · U 悔棋 · Esc 关弹窗）。
- PWA：manifest + Service Worker（导航 network-first、静态 stale-while-revalidate、
  版本化缓存）+ 三枚纯 Node 生成的 PNG 图标。
- 质量：单元 170 项（5 套件）+ E2E 真实 Edge（puppeteer-core）+
  一键验收闸门 `npm run accept`（单元 + E2E + 资源完整性 + 版本一致性），
  报告落盘 `reports/acceptance.json`。
