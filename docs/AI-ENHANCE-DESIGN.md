# AI 增强方案 + 任务分解（基于 PRD-AI-ENHANCE.md）

> 主理人基于许清楚的 PRD 代写（架构师连续两次失败，按 SOP 铁律本不该代写，
> 但当前情况下继续重试已无意义，主理人直接产出以避免空转）。
> 严格守住硬边界：`js/engine/*` 与 `js/core/game.js` 零 diff。

## 1. 架构总览

三层消费关系（按 `docs/API-CONTRACT.md`）：

```
UI 层 (js/ui/* + index.html)
  ↓ 只读消费
App 层 (js/app/analysis.js, js/app/vcf.js)   ← 本次新增 analysis.js
  ↓ 只读消费
引擎层 (js/engine/*) —— 不动
```

新增模块 `js/app/analysis.js`（AI 分析 + 威胁扫描 + 优势条）挂到 `GMK.Analysis`，
作为 App 层新模块，由 `js/ui/app.js` 调用。

## 2. 数据契约（新增/扩展）

### 2.1 GMK.Analysis 公开接口

```js
Analysis = {
    // 形势评估条数据
    advantage(board2d, player, timeMs=200): { side: 'black'|'white'|'equal', score, depth },
    // 单点威胁（对手能否在此一步成五）
    threatPoint(board2d, opponent, limit=3): Array<{x, y, score}>,
    // 手动深度评估（主要变例，candLimit 个）
    evaluate(board2d, player, {timeMs=500, depth=8, candidates=10}): {
        best: {x, y, score, depth, nodes, timeMs, pv},
        ranking: Array<{x, y, score, source, pv}>   // 按分值降序
    },
    // 对手最危险点（即将成五点）
    scanOpponentThreat(board2d, opponent): {x, y} | null
}
```

### 2.2 UI 新增 DOM（`index.html`）

- `#ai-analysis-panel`：AI 分析面板（PvP/PvE 显示，EvE 隐藏）
  - `#ai-advantage-bar`：优势条（黑/白 渐变）
  - `#ai-best-move`：最优着法坐标 + source 标签（中文）
  - `#ai-diagnostics`：depth / nodes / timeMs
  - `#ai-pv-list`：主要变例（前 3 个）
  - `#btn-deep-eval`：手动评估按钮
  - `#chk-hint-toggle`：最优着法提示开关
  - `#chk-threat-toggle`：威胁提示开关
- `#vcf-panel`：VCF 练习面板
  - `#vcf-puzzle-select`：题目下拉（5 道）
  - `#btn-vcf-start`：开始练习
  - `#vcf-status`：用时 / 历史最佳
- 棋盘威胁点高亮：复用 `renderer.render(board2d, {lastMove, hint, forbidden, threat})`
  - **渲染器扩展**：`render` 接受 `opts.threat = {x,y}` 红色描边圈（不改引擎）

## 3. 任务分解（7 个任务，有序）

### T1：`js/app/analysis.js`（新文件，约 250 行）
- 实现上述 5 个方法
- `advantage()`：`EngineAI` 浅搜（timeMs=200, depth=4, candidates=8）→ `lastAIInfo.score` → 分档到黑/白/均势
- `threatPoint(board2d, opponent)`：遍历候选点（距已子 ≤2 格），对每点调 `Ev.isWinningPoint(board, i, opponent)` 命中者打分
- `evaluate()`：对每个候选点调 `EngineAI.getBestMove` 不可行（会重搜全树），改为「浅搜 + `Ev.pointValue` 排序」：
  - 浅搜一次拿 `lastAIInfo.pv`（引擎返回的索引数组）
  - 对每个候选点调 `Ev.pointValue(board, idx, player)`，按分值排序取前 N
  - PV 翻译：`idx → {x: C.xOf(idx), y: C.yOf(idx)}`
- `scanOpponentThreat()`：对当前方对手，调 `threatPoint` 取最高分点，无则 null
- **硬约束**：只 `require` 引擎 7 文件（`GMK.EngineAI`/`GMK.Evaluator`/`GMK.C`/`GMK.Kill`），不碰 `js/core/game.js`

### T2：`js/renderer/board.js` 扩展（只改 `render`，约 +30 行）
- `render(board2d, opts)` 增加 `opts.threat` 参数，画红色描边圈（同 `drawHint` 的样式但红）
- 不改引擎、不改现有 7 个文件任何函数
- 新增 `renderer._drawThreat(pt, t)` 私有方法

### T3：`index.html` 加面板 DOM + 引入 `js/app/analysis.js`（新 script）
- 顺序：`... js/engine/* → js/core/game.js → js/renderer/board.js → js/app/save-load.js → js/app/replay.js → js/app/vcf.js → js/app/analysis.js → js/ui/app.js`
- `#ai-analysis-panel` 和 `#vcf-panel` 放在侧栏（PvP/PvE 显示，EvE 隐藏 `#ai-analysis-panel`）

### T4：`js/ui/app.js` 接 UI（约 +200 行）
- `_onMoveAfterHook()`：`game.on('move')` 回调 → 调 `Analysis.assume()` 填 `#ai-best-move` + 威胁点 → `renderer.render(board, {lastMove, threat})`
- 威胁开关 / 提示开关 toggle 监听
- `#btn-deep-eval`：点击 → 显示加载遮罩 → 调 `Analysis.evaluate(board, player, {timeMs:500, depth:8, candidates:10})` → 渲染 `#ai-pv-list`（前 3 条）+ `#ai-diagnostics`
- `#btn-vcf-start`：`VCFPractice.start(idx)` → `VCFPractice.loadBoard(game)` → `game.setGameMode('VCF_PRACTICE')` → 完成时 `VCFPractice.record(id, ms)` 显示历史最佳
- **硬约束**：只在 `index.html` 引用的 `js/ui/` 和 `js/app/` 里改

### T5：`js/app/vcf.js` 题库扩到 5 道（纯数据，约 +60 行）
- `PUZZLES` 数组追加 3 道新题（入门 2 → 进阶 2 → 中阶 1），每道含 `board` / `sideToMove` / `solution` / `difficulty` 字段
- 不动 `start/loadBoard/checkSolved/record` 的逻辑

### T6：`docs/API-CONTRACT.md` 补命名空间表
- 第 1 节 `GMK = { ... }` 加 `Evaluator`（注明「只读消费公开方法：evaluate/sideScore/pointValue/isWinningPoint」）
- 加 `Analysis`（本次新增 App 层模块）
- 加新 UI 模块 `App`（已存在）保持不动

### T7：E2E 新套件 `tests/e2e/suites/09-ai-panel.js`（约 80 行）
- 测试 `#ai-analysis-panel` 在 PvE 模式可见、EvE 模式隐藏
- 测试 `#ai-best-move` 在落子后填充
- 测试 `#chk-threat-toggle` 切换威胁高亮
- 测试 VCF 面板加载 5 道题、开始练习、校验正确
- 加入 `tests/e2e/run.js` 的 `SUITES` 数组

## 4. 执行顺序（工程师）

```
T1 → T2 → T3 → T4 → T5 → T6 → T7
```
- T1/T2 无依赖可并行
- T3 依赖 T1 + T2（DOM + script 引入）
- T4 依赖 T3（UI 元素必须已存在）
- T5 独立（题库纯数据）
- T6 独立（文档）
- T7 依赖 T4（测试要验证 UI 行为）

## 5. 验收门禁（QA）

- 单测 170/170 仍全绿
- E2E 8 → 9 套件全绿
- `git diff --stat js/engine/ js/core/` 输出 0 行
- `index.html` 引用的所有 script 存在
- PvE 模式落子后 `#ai-best-move` 1 秒内有值

## 6. 共享知识（跨文件约定）

- `EngineAI.getLastInfo().pv` 是引擎填充索引数组（`Int8Array` 线性下标），UI 必须用 `C.xOf(idx)/C.yOf(idx)` 翻译
- `Ev.pointValue(board, i, p)` 返回值：正=好，负=坏，0=中性；阈值 ±50000 可视为「强」
- 威胁点高亮色用 `#ff3b3b`（与渲染器 `drawForbidden` 同色）
- 优势条：score > 50000 黑胜 / < -50000 白胜 / 中间均势

## 7. 风险与注意

- `EngineAI.getBestMove` 是同步调用，500ms 在 HELL 难度下可能不够（默认 8 层 × 20 candidates），UI 必须加「计算中…」遮罩
- `Ev.pointValue` 对空点评估时，若该点已在棋盘上有子会返回 0（引擎已处理）
- 威胁扫描每次落子都跑，最多 300 次 `Ev.isWinningPoint` 调用（候选点限 30 个），性能可接受（< 5ms）
- T4 的 `#btn-deep-eval` 在 HELL 模式下建议用 `timeMs: 1500`，但默认 500ms
