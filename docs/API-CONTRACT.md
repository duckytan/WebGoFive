# 重构 API 契约（v2.0）

> 目标：界面与 AI 算法可独立替换。引擎 / 核心 / UI 三层之间用显式契约解耦，
> 任何一层重写都不强迫其他层跟着改。

## 1. 命名空间

浏览器全局 `window.GMK`，Node 测试用 `module.exports`。无构建、无 import/export。

```
GMK = {
  C,                 // constants.js —— 常量
  Board,             // board.js —— 一维棋盘 + 棋型统计
  Evaluator,         // evaluator.js —— 静态评估
  Kill,              // kill.js —— VCF 算杀
  Forbidden,         // forbidden.js —— RIF 禁手
  Search,            // search.js —— PVS + TT
  EngineAI,          // gomoku-ai.js —— AI 门面（实现 GomokuAI）
  Game,              // core/game.js —— 游戏核心（GomokuGame）
  Renderer,          // renderer/board.js —— Canvas 渲染器
}
```

> **Evaluator 说明（增量，AI-ENHANCE T6）**：`Evaluator` 是现成公开命名空间
> （`js/engine/evaluator.js`），本次 AI 增强中 UI/App 层**只读消费**其公开方法，
> 不改引擎：
>
> - `evaluate(board, p)` → 视角方 p 的局面分（正=p 占优，零和：`evaluate(p) === -evaluate(opp)`）
> - `sideScore(board, p)` → 单方棋型分
> - `pointValue(board, i, p)` → 在填充索引 i 落 p 子的静态价值（正=好 / 负=坏 / 0=中性；≥ 50000 视为「强」）
> - `isWinningPoint(board, i, p)` → i 是否为 p 的一步成五点
>
> 消费方：`js/app/analysis.js`（`GMK.Analysis`）。
> 注：`EngineAI.getLastInfo().pv` / `info.move` 均为**填充索引**，
> 消费方必须用 `C.xOf(idx)` / `C.yOf(idx)` 翻译成棋盘坐标。

## 2. AI 接口（GomokuAI）

任何 AI 实现只要满足：

```js
class SomeAI {
  constructor(game) {}          // game: GomokuGame
  getMove(difficulty)           // → {x, y} | null
  getLastInfo()                // → {player,difficulty,level,source,move,score,depth,nodes,vcf,timeMs}
  sync()                       // 把 game.board 同步到 AI 内部（如引擎）
}
```

核心不 `new` 具体 AI，靠 `game.setAI(impl)` 注入。默认 `new GMK.EngineAI(game)`。

## 3. 核心（GomokuGame）公开方法

```
placePiece(x, y)            → {success, gameOver?, winner?, winLine?, reason?, nextPlayer?}
undo(steps=1)               → boolean
reset()                     → void
setGameMode(mode)           mode ∈ {PvP, PvE, EvE, VCF_PRACTICE}
setAIDifficulty(d)          d ∈ {BEGINNER, NORMAL, HARD, HELL}
setBlackAIDifficulty(d) / setWhiteAIDifficulty(d)
setAI(impl)                // 注入 GomokuAI，默认 EngineAI
getAIMove()                 → {x,y}|null（走当前注入的 AI）
checkForbidden(x,y)        → {isForbidden, type?, details?}
getGameInfo() / getBoardState() / getMoves() / getLastMove()
loadFromData(data) / exportData() / loadCustomState(opts)
on(event, cb)              event ∈ {move, undo, reset, over, aiMove, forbidden}
```

事件载荷：
- `move` → `{x, y, player, step, result}`
- `over` → `{winner, reason, winLine?}`
- `forbidden` → `{x, y, type, details}`

## 4. 渲染器（Renderer）

```
new Renderer(canvas, opts)
  opts: { theme, dpr, showCoords }
render(board2d, opts)      // opts: {lastMove?, hint?, forbidden?, winLine?}
on('click', ({x,y}) => {})
on('hover', ({x,y}) => {})
setTheme(name) / setShowCoords(bool)
```

渲染器**不持有任何游戏状态**，纯 `board2d → 画布`。坐标换算在渲染器内部（DPR 感知）。

## 5. UI / App 层

- `js/ui/app.js` —— 启动、模式切换、提示条、加载遮罩（就绪即隐藏）
- `js/ui/modals.js` —— 结算 / 设置 / 帮助 / 快捷键弹窗
- `js/app/save-load.js` —— localStorage 自动存/读
- `js/app/replay.js` —— 回放器
- `js/app/vcf.js` —— VCF 练习（题库 5 道，含 `difficulty` 字段）
- `js/app/analysis.js` —— AI 分析层（新增，挂 `GMK.Analysis`）

```
GMK.Analysis = {
  advantage(board2d, player)        → {side:'black'|'white'|'equal', score, depth}  // 形势条（浅搜 200ms）
  threatPoint(board2d, opponent, limit=3) → Array<{x, y, score}>                    // 对手一步成五点（候选按 pointValue 预排序取 top-N）
  evaluate(board2d, player, {timeMs=500, depth=8, candidates=10})
                                   → {best:{x,y,score,depth,nodes,timeMs,pv},
                                      ranking:Array<{x,y,score,pv,source?}>,
                                      source}
  scanOpponentThreat(board2d, opp)  → {x, y} | null                                  // 最危险点
  openingRecommendation(board2d, player, {window=4})
                                   → {x, y, score, stones} | null                    // 开局定式推荐（P2-6，盘面 ≥ window 子返回 null）
}
```

> **Analysis 契约要点（AI-ENHANCE T6）**：
> - 输入 `board2d` 为二维数组（`game.getBoardState()` 形态）；输出坐标为棋盘坐标（非填充索引）。
> - `ranking[].source` 仅取引擎合法值 `{search, vcf, blunder}`（引擎来源点才带 `source`）；
>   其余由 `Ev.pointValue` 静态排序补出的条目**不带 source 字段**（避免把静态估价误标为引擎来源）。
> - `evaluate` 内部只映射 `timeMs / depth / candidates` 给 `EngineAI.getBestMove`
>   （该 API 不透传其它键），不额外传 `useKill`。
> - 威胁扫描候选先按 `Ev.pointValue` 预排序再截断（`SCAN_MAX=30`），不按行序截断，
>   避免中/下半盘成五点被漏检。
> - 本层只读消费 `EngineAI / Evaluator / C / Kill`，`js/engine/*` 与 `js/core/game.js` 零改动。

### 可调参 AI（P2-5 增量，`js/app/tunable-ai.js`）

```
GMK.TunableAI = {
  LIMITS                            // {timeMs:{min:100,max:10000}, depth:{min:1,max:24}, candidates:{min:4,max:64}}
  defaults()                        // → 引擎 C.LEVELS.HELL 的 {timeMs, depth, candidates}
  sanitize(opts)                    // → 非数值回退默认 / 取整 / 夹界（纯函数）
  equalsDefault(s)                  // → sanitized 是否等于引擎默认
  createWrapper(engine, [stateBox]) // → 满足 GomokuAI 契约的包装 AI：
                                    //    getMove(difficulty) / getLastInfo() / sync()
                                    //    setOverride(opts) / override（getter）
}
```

> **TunableAI 契约要点**：
> - 非 HELL 难度、未自定义参数、或参数等于引擎默认时，`getMove` 原样委托
>   `engine.getMove(difficulty)`；HELL + 自定义参数走公开契约
>   `engine.getBestMove(game.getBoardState(), game.currentPlayer, opts)` 透传。
> - 包装层必须先做终局守卫再透传：`getBestMove` 内部会换上
>   `gameStatus:'playing'` 的临时 game，会绕过引擎自身的终局判断。
> - App 启动时 `game.setAI(TunableAI.createWrapper(new EngineAI(game)))`
>   注入（换 AI 契约的标准用法）；`lastAIInfo` 诊断链路不变。

UI 层只通过 `game.on(...)` 订阅事件 + 调 `game` 公开方法 + 调 `renderer` 公开方法。
**不直接读 `game.board` 内部**（用 `game.getBoardState()`）。

### 渲染器增量（AI-ENHANCE T2）

`render(board2d, opts)` 新增可选参数：

```
opts.threat = {x, y}   // 威胁点（对手一步成五处）：红色描边圈，#ff3b3b
```

与既有 `lastMove / hint / forbidden / winLine` 同通道，不开新渲染路径。

## 6. 替换场景验证

| 场景 | 需要动的文件 | 不动的文件 |
|---|---|---|
| 换界面（如改 Vue/React） | `js/ui/`、`index.html`、`css/` | `js/engine/*`、`js/core/*`、`js/app/*` |
| 换 AI（如换开源引擎） | 新写一个类实现 `GomokuAI`，`game.setAI(new X(game))` | 引擎原文件、核心、UI |
| 换棋盘规格（19×19） | `js/engine/constants.js` 的 `SIZE` + 渲染器 `boardSize` | 核心逻辑、UI 事件 |
