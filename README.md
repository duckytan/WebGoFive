# WebGoFive H5 · 五子棋（v2）

内置自研 AI 引擎的 H5 五子棋：人机 / 双人 / AI 对打、AI 分析面板、实时威胁提示、
开局定式推荐、VCF 冲四练习、棋局存档回放，PWA 可安装、可离线游玩。
纯原生 ES6，零构建、零外部资源。

> v2 是在 v1.4.0 引擎（171 项测试背书）之上的全新重构版：核心 / 渲染器 / UI 全部重写，
> 按 `docs/API-CONTRACT.md` 三层解耦。重构思路与旧版对比见 `DELIVERY_PROGRESS.md`。

## 功能

- **对局**：PvP 双人 / PvE 人机 / EvE AI 对打；难度 入门 / 普通 / 困难 / 地狱；
  RIF 禁手规则（可选三三 / 四四 / 长连判定）；悔棋、新局、结算弹窗、再来一局。
- **AI 分析面板**：形势优势条（黑 / 白 / 均势）、AI 推荐落点与来源语义
  （搜索所得 / 算杀截断 / 防亏手）、深度 / 节点 / 耗时诊断、主要变例（前 3）、
  手动深度评估（时间 / 深度 / 候选数可调）。
- **提示**：AI 最优点提示（黄色）、对手一步成五点威胁高亮（红色），均可开关；
  开局定式推荐 —— 前 4 手内自动给出按引擎 pointValue 中心性挑选的开局点。
- **高级棋力选项**：地狱难度下可自定义搜索时间（100–10000ms）/ 深度（1–24 层）/
  候选数（4–64 个），经包装 AI 透传 `getBestMove`，参数自动夹界并持久化。
- **VCF 冲四练习**：5 道内置题（入门 2 / 进阶 2 / 中阶 1），选题 → 加载 →
  校验 → 计时 → 历史最佳。
- **回放与存档**：步进 / 快进 / 跳步回放；localStorage 自动存档，重开自动恢复。
- **外观**：木质 / 深色 / 浅色三套主题；棋盘坐标开关；移动端 390px 响应式；
  快捷键 `N` 新游戏 · `U` 悔棋 · `Esc` 关弹窗。
- **PWA**：可安装到主屏；Service Worker 离线缓存（导航 network-first、
  静态 stale-while-revalidate、版本化缓存名，升级自动清旧缓存）。

## 快速开始

```bash
cd WebGoFive-H5-v2
npm install        # 仅 devDependencies：puppeteer-core（E2E 用）
npm start          # 本地预览 http://127.0.0.1:8080（零依赖静态服务器）
```

直接双击 `index.html` 也能玩，但 PWA 离线与自动存档在 http(s) 环境下更完整。

## 测试与验收

```bash
npm test           # 单元 218 项（engine / forbidden / vcf / search / loadorder / tunable）
npm run test:e2e   # E2E 10 套件（真实 Edge，puppeteer-core 驱动）
npm run accept     # 一键验收闸门：单元 + E2E + 资源完整性 + 版本一致性
npm run bench      # 性能基准
npm run selfplay   # 棋力自对弈（勿与 CPU 密集任务并行）
```

`npm run accept` 是唯一交付判据，全绿（退出码 0）才算可交付；
报告落盘 `reports/acceptance.json`。版本号四处源（package.json /
manifest.webmanifest / `#app-version` 徽标 / sw.js 缓存名）由闸门统一校验，
改版本时四处同步改。

## 架构

```
UI 层  js/ui/app.js          启动、模式切换、面板接线、快捷键、EvE 排期
         ↓ 只读消费
App 层  js/app/analysis.js   AI 分析 / 威胁扫描 / 优势条 / 开局推荐（GMK.Analysis）
        js/app/tunable-ai.js HELL 高级棋力参数清洗与透传（GMK.TunableAI）
        js/app/vcf.js        VCF 练习题库与流程
        js/app/save-load.js  localStorage 自动存档
        js/app/replay.js     回放器
         ↓ 只读消费
核心    js/core/game.js      GomokuGame：状态机 / 规则 / 事件 / AI 注入
渲染器  js/renderer/board.js BoardRenderer：DPR / 主题 / 点击换算 / 威胁高亮
引擎    js/engine/*          PVS 搜索 + VCF 算杀 + 禁手（GMK.EngineAI 等）
```

- 换 UI 不碰引擎 / 核心；换 AI 不碰页面 / 核心 —— 契约见 `docs/API-CONTRACT.md`。
- 所有模块挂 `window.GMK.*`：浏览器 `<script>` 直接加载，Node 直接 `require` 测试。
- 新增功能只消费公开契约，`js/engine/*` 与 `js/core/game.js` 保持零改动
  （v2.1 AI 增强、v2.2 棋力增强均按此约束完成）。

## 目录速览

```
index.html              语义化骨架 + 内联面板样式 + 脚本加载顺序
manifest.webmanifest    PWA 元数据
sw.js                   Service Worker（离线缓存）
css/                    style / themes / animations（390px 响应式）
js/                     engine 7 文件 · core · renderer · app · ui
assets/                 icon-192 / 512 / maskable-512（纯 Node 生成）
tests/                  engine 单测 · e2e（harness + 10 套件）· accept.js
tools/                  serve.js 静态服务 · gen-icons.js 图标生成
docs/                   API-CONTRACT.md · PRD-AI-ENHANCE.md · AI-ENHANCE-DESIGN.md
```

## License

[MIT](LICENSE)
