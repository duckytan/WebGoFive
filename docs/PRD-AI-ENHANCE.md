# PRD：AI 功能完善（增量）

- **项目**：WebGoFive-H5-v2（H5 五子棋）
- **类型**：增量开发（在已验收的 v2.0 之上加 AI 能力，不重写引擎）
- **语言**：JavaScript（ES5 风格 IIFE，无构建），UI 为原生 DOM + Canvas（`js/ui/app.js` + `index.html`）
- **原始需求**：继续完善游戏，特别是 AI 功能。

## 1. 产品定义

### 1.1 产品目标

1. **可解释**：玩家每次落子后能看到 AI 视角的分析（最优着法、形势评估），而不仅是一个落子坐标。
2. **可学习**：通过威胁高亮与 VCF 练习面板，把引擎已有的「VCF 算杀 / 单点价值 / 禁手」能力变成学习工具。
3. **不破坏**：全部新功能只消费 `docs/API-CONTRACT.md` 公开契约，`js/engine/*` 与 `js/core/game.js` 零改动。

### 1.2 用户故事

- As a 玩家，I want 在 PvE 模式下每步之后看到「AI 认为的最优着法提示 + 简明形势说明」，so that 我知道自己刚才走得好不好。
- As a 新手，I want 对手即将成四/活三时棋盘上高亮提醒，so that 我不会被一步杀死而不自知。
- As a 练习者，I want 一个 VCF 冲四练习面板（选题、加载棋盘、校验解法、记录用时），so that 我能系统练习算杀而不用找外部棋谱。
- As a 进阶玩家，I want 对任意局面手动触发「深度评估」（选时间/深度/candidates），so that 我可以研究关键分叉的变例。
- As a 棋力自测者，I want 看到一条「优势条」（哪方领先、幅度大致多强），so that 我不用数棋型就能判断形势。

## 2. 现状盘点（给开发者的关键事实）

| 层 | 位置 | 可复用能力 |
|---|---|---|
| 引擎 | `js/engine/` | `EngineAI.getMove(game, difficulty)`；`EngineAI.getBestMove(grid, player, {difficulty, timeMs, depth, candidates})` 可对任意局面评估；`EngineAI.getLastInfo()` 返回 `{player, difficulty, level, source, move, score, depth, nodes, vcf, timeMs}`，`source ∈ {search, vcf, blunder}`；`GMK.Kill.vcf(board, p, depth)`；`GMK.Evaluator.pointValue(b, i, p)`、`GMK.Evaluator.isWinningPoint`、`Ev.evaluate / sideScore`（评估函数已存在） |
| 核心 | `js/core/game.js` | `game.setAI(impl)`、`game.getAIMove()`、`game.lastAIInfo`、`game.getBoardState()`、`game.on(event, cb)`（事件 `move/undo/reset/over/aiMove/forbidden`） |
| App | `js/app/vcf.js` | `GMK.VCFPractice`：`PUZZLES`（2 内置题）、`start(idx)`、`loadBoard(game)`、`checkSolved(board2d)`、`record(id, ms)`、`getBest()`，但 **`index.html` 没有对应面板** |
| UI 缺口 | `js/ui/app.js` | 无 AI 分析面板、无实时威胁高亮、无优势条、无手动评估入口 |

> 注意：`GMK.Evaluator` 未在 `API-CONTRACT.md` 第 1 节命名空间表中显式声明，但其 `evaluate/sideScore` 是现成公开方法。按「只读消费公开方法」原则使用，不改引擎。

## 3. 需求池

### P0（必须做）

1. **AI 分析面板**（`index.html` 新增 DOM + `js/ui/` 新增模块）
   - 每步（玩家或 AI 走子后）显示：AI 视角最优着法坐标 + `getLastInfo()` 诊断（`source` 语义：`search`=搜索所得、`vcf`=算杀截断、`blunder`=防亏手；score / depth / nodes / timeMs 可读化）。
   - 「最优着法提示」开关（默认开）：在棋盘上以 `renderer.render` 的 `hint` 参数画出 AI 推荐点，不覆盖落子。
   - 手动「深度评估」按钮：调用 `EngineAI.getBestMove(game.getBoardState(), 当前方, {timeMs, depth, candidates})`，结果以主要变例列表（candidates 分值排序）展示。
2. **实时威胁提示**
   - 用 `Ev.isWinningPoint(board, i, 对手)` 扫描（或 `Ev.pointValue` 阈值）：当对手下一手即可成五时，高亮该点（警告色）；可选高亮「活三/冲四点」。
   - 通过 `game.on('move')` 触发，PvP/PvE 双方模式均生效；`over` 时清除。

### P1（应该做）

3. **VCF 练习接 UI**
   - `index.html` 加「VCF 练习」面板：题目列表（`VCFPractice.PUZZLES`，含难度标签）、开始（`start` + `loadBoard(game)` + 切 `VCF_PRACTICE` 模式）、校验（`checkSolved`）、记录（`record(id, ms)` + `getBest()` 显示历史最佳）。
   - 内置题扩展到 5 道以上（入门→进阶），题数据放 `js/app/vcf.js` 或独立 `js/app/vcf-puzzles.js`。
4. **形势评估条**
   - 一条横向优势条：基于 `EngineAI.getBestMove` 或 `Ev.evaluate` 的 score，渲染为「黑领先 / 白领先 / 均势」渐变条 + 数值。放在分析面板顶部，轻量（小 timeMs/浅 depth，避免每步重搜索卡 UI）。

### P2（可延后）

5. **棋力增强选项**：HELL 难度下暴露「搜索时间 ms / 深度 / candidates 数量」高级选项，透传给 `getBestMove`。
6. **开局定式推荐**：前 4 手内，按 `pointValue` 中心性给「推荐开局点」；与 P0 提示开关复用渲染路径。

## 4. UI 设计稿（文字布局）

- **主布局**：保持现有「棋盘居左/中，控制面板居右」结构；控制面板新增两个可折叠区块：
  1. **AI 分析**（P0）：顶部形势条（P1）；正文区显示「AI 推荐落点 (x,y)」「诊断」（source 中文标签 + 用时/深度/节点）；按钮：[深度评估]（弹出 timeMs/depth/candidates 表单）、提示开关、威胁提示开关。
  2. **VCF 练习**（P1）：题目下拉 + [开始练习]；完成后显示 [用时 / 历史最佳]；失败 3 步自动给提示（可选 P2）。
- **棋盘渲染**：威胁点 = 红色描边圈；AI 推荐点 = 黄色半透明圆点；最近手 = 现有 `lastMove`。均走 `renderer.render(board2d, {lastMove, hint, forbidden})`，不新开渲染通道。
- **交互**：评估是同步/长耗时调用，显示「AI 计算中…」遮罩（复用现有加载遮罩）；结果出来后刷新面板。

## 5. 边界与约束（硬要求）

1. **新增功能只走 `docs/API-CONTRACT.md` 公开契约**：只消费 `game.*`、`renderer.render`、`GMK.EngineAI` / `GMK.Evaluator` / `GMK.Kill` / `GMK.VCFPractice` 的公开方法。
2. **不改 `js/engine/*`（7 个文件）与 `js/core/game.js`**：全部增量放在 `index.html`、`js/ui/`、`js/app/`。
3. **异步注意**：`getBestMove` 在 JS 主线程同步执行，HELL 级可能 >1s；必须加加载遮罩 + 默认限制 timeMs（建议默认 500ms），避免卡死触摸交互。
4. **回归基线**：`tests/` 现有 170 单测保持全绿；为新 UI 模块（面板、威胁扫描、VCF 面板）补 DOM 无依赖的单测（纯逻辑抽到函数）。
5. **移动端**：面板宽度 < 480px 时折叠为底部抽屉（现有控制面板已有响应式处理，沿用）。

## 6. 待确认问题

| # | 问题 | 建议默认值 |
|---|---|---|
| Q1 | 深度评估放主线程同步（现状）还是拆 Web Worker？ | 主线程 + 默认 500ms 上限，P2 再做 Worker 化 |
| Q2 | 威胁提示是否高亮「活三/冲四」（弱威胁）还是仅「成五点」（强威胁）？ | P0 只做成五点，活三/冲四为 P1 开关项 |
| Q3 | VCF 题库是否接受玩家提交题（localStorage 自定义）？ | P2，本期仅内置题 |
| Q4 | 分析面板在 EvE 模式下是否对双方同时显示？ | 显示当前落子方视角，随回合切换 |
| Q5 | `Evaluator.evaluate` 是否稳定对外承诺（契约表未列 Evaluator）？ | 视为已发布事实，仅读不改 |

## 7. 验收标准

- P0 两项在 15×15 PvE 中可用：AI 每步后 1s 内出分析（HARD），威胁点在对手成五前出现。
- P1 两项：至少 5 道 VCF 题可完整「加载→求解→校验→记录」；形势条在均势/领先两种局面显示正确方向。
- 全量单测通过，`js/engine/` 与 `js/core/` 的 diff 为空。
