# WebGoFive H5 v2.8.1 — fresh-eyes 最终独立验收报告

- 执行人：QA 严过关（Edward / software-qa-engineer）
- 执行时间：2026-11-04T13:08:44.894Z（脚本 `startedAt`）
- 被测提交：本地 HEAD = `31075fbcefa1b0c604a82cc1abdabfe830b3f192`
- 远端对齐：release-sync 通报远端 main = `31075fbcefa1b0c604a82cc1abdabfe830b3f192`，与本地 HEAD 一致
- 环境：真实 Edge `155.0.4283.62` + `puppeteer-core 24.43.1` + Node `v24.22.2`
- 复现命令：`node tests/qa/final-2.8.1-audit.js`
- 机器可读证据：`tests/qa/final-2.8.1-audit.log`（完整 trace，含逐请求 URL/状态）

---

## 0. 结论

**判定：PASS（28/28 硬判定项全通过，无 fatal、无 failedChecks）**

- 核心命题「**Worker 静默回退被当成成功**」：**已被证伪（排除）**。
  - 负向对照确实能把 `via` 从 `'worker'` 打到 `'sync'`，且回退结果结构正常 → `via` 不是常量、fallback 可观测；
  - 正常路径 `via === 'worker'` 且服务端实测 **9 个 worker 侧请求全部 200**（1 入口 + 7 引擎 + `analysis.js`），零 4xx；
  - 域名根与 `/sub/path/` 子路径**均已实测通过**，非推断。
- 发布建议：**可请用户发布线上版**。下方 3 条观察项均为文档/注释/夹具层面，不影响运行时逻辑，不阻塞发布。
- `route = NoOne（交付）`

---

## 1. 验收边界与方法

### 1.1 只读边界（已遵守）

- 产品源码、已有测试、配置（`package.json` / `sw.js` / `manifest.webmanifest` / `index.html` 等）**零改动**；
- 未重跑 `node tests/accept.js`、`node tests/e2e/run.js`：二者会**重写 `reports/acceptance.json` / `reports/e2e.json`**（含 `generatedAt`），在发布定稿期会制造工作区中间态，干扰 release-sync 判断。替代证据见 §3。
- 唯一新增文件全部位于 `tests/qa/`：`final-2.8.1-audit.js`（验收脚本）、`final-2.8.1-audit.log`（被 `.gitignore:18 *.log` 忽略）、本报告。

### 1.2 观测手段与夹具披露（重要）

| 项 | 做法 | 理由 |
|---|---|---|
| 硬证据来源 | 自建 `http.createServer`，记录**服务端收到的每个请求 URL 与响应状态** | Worker 惰性创建，在「页面就绪 → 清空日志 → 调 `run()`」窗口内出现的请求必然是 Worker 入口 + `importScripts`，不与页面 `<script>` 混淆；不依赖 CDP target 归属 |
| SW 隔离 | QA 独立服务对 `/sw.js` 返回 404（`navigator.serviceWorker.register('sw.js').catch(()=>{})` 静默吞掉） | `sw.js:91-103` 是 **cache-first**，若命中缓存则服务端观测不到 Worker 的 `importScripts` 请求，验收将失去区分力。**被测 Worker 逻辑零改动** |
| 缓存抑制 | 所有响应 `Cache-Control: no-store, must-revalidate`；page CDP session `Network.setCacheDisabled(true)` + `Network.setBypassServiceWorker(true)` | 防止 HTTP 内存缓存掩盖请求 |
| CDP autoAttach | **未启用** browser-level `Target.setAutoAttach(flatten)` | puppeteer 24.x 内部已用 flatten 管理 target，重复附着存在干扰其生命周期的风险；改用 `page.on('workercreated')` + 服务端请求日志（team-lead 方案中的「或独立静态服务端日志」分支）。该取舍如实记录于 trace 的 `cdp.autoAttach` 字段 |
| 404 注入 | **双通道**：A = CDP `page.setRequestInterception` + `req.respond(404)`；B = 静态服务返回真实 HTTP 404（不经过 CDP） | 避免只靠单一通道下结论；B 同时验证「真实 HTTP 404」（而非 CDP 伪造响应）同样触发 `worker.onerror → runSync` |

> 附带实证：`page.on('request')` 在通道 A **确实命中了 worker URL**（`interceptionHits = 1`），说明该请求在 page target 层可观测，先前「可能只属于独立 worker target 因而拦截不到」的担心不成立。

---

## 2. 四步验收结果

### 步骤 1 — 负向对照（双通道，root + subpath 各跑一遍）

| 场景 | 通道 | 注入证据 | `via` | 结果结构 | `ranking` |
|---|---|---|---|---|---|
| root | A · CDP `respond(404)` | `interceptionHits=1`，`injected404SeenByServer=0`（CDP 在网络层之前 respond，请求未到服务端，**预期行为**） | `sync` | 正常（`best` + `ranking≥3`） | 8 |
| root | B · 服务端真实 HTTP 404 | `injected-404=1`，URL `/js/app/deep-eval-worker.js` status 404 | `sync` | 正常 | 8 |
| subpath | A · CDP `respond(404)` | `interceptionHits=1` | `sync` | 正常 | 8 |
| subpath | B · 服务端真实 HTTP 404 | `injected-404=1`，URL `/sub/path/js/app/deep-eval-worker.js` status 404 | `sync` | 正常 | 8 |

补充：`workerCreatedInNegative = 1`（root/subpath 均是）—— 即使脚本 404，Chrome 仍创建了 worker target，随后 `js/app/deep-eval.js:61-68` 的 `worker.onerror → workerBroken → reject → runSync` 链路真实生效。负向对照窗口内服务端日志为空（通道 A）是 fixture 设计所致，已在 log 的 `negative.note` 字段写明，**不是观测失败**。

结论：`via` 非常量（负向 `sync` ≠ 正向 `worker`），fallback 路径可观测且结果结构正常。

### 步骤 2 — 正常路径（域名根）

- 撤销拦截后 **显式 `page.reload()`** 清掉 `workerBroken` 单例（team-lead 指定），再调 `GMK.DeepEval.run()`：
  `via = 'worker'`，结果结构正常，`ranking = 8`。
- `page.on('workercreated')` 捕获：`http://127.0.0.1:<port>/js/app/deep-eval-worker.js`。
- **窗口内共 9 个请求、9 个不同 URL、全部 `200 / served`、零 4xx**：

```
/js/app/deep-eval-worker.js     200
/js/engine/constants.js        200
/js/engine/board.js            200
/js/engine/evaluator.js        200
/js/engine/search.js           200
/js/engine/kill.js             200
/js/engine/forbidden.js        200
/js/engine/gomoku-ai.js        200
/js/app/analysis.js            200
```

- 正常路径窗口内 `pageErrors = []`。

即：先证明**观测到 9 个 worker 侧请求**，再证明**零 4xx**（team-lead 设定的硬门槛顺序）。

### 步骤 3 — 子路径部署 `/sub/path/`（**已实测**）

- 静态服务把整个项目挂到 `/sub/path/` 前缀下，重跑步骤 2：
  `via = 'worker'`，结果结构正常，`ranking = 8`。
- `workercreated` URL：`http://127.0.0.1:<port>/sub/path/js/app/deep-eval-worker.js`。
- **9 个请求全部带 `/sub/path/` 前缀、全部 200、零 4xx**：

```
/sub/path/js/app/deep-eval-worker.js     200
/sub/path/js/engine/constants.js        200
/sub/path/js/engine/board.js            200
/sub/path/js/engine/evaluator.js        200
/sub/path/js/engine/search.js           200
/sub/path/js/engine/kill.js             200
/sub/path/js/engine/forbidden.js        200
/sub/path/js/engine/gomoku-ai.js        200
/sub/path/js/app/analysis.js            200
```

- `allUrlsHavePrefix = true`，`pageErrors = []`。

结论：`document.currentScript.src` + `new URL('deep-eval-worker.js', cs.src)` 的根绝对路径修复**在子路径下确实生效**；`importScripts('../engine/…', 'analysis.js')` 的相对解析也正确。此项为实测，不是从域名根结果推断。

### 步骤 4 — 版本源 / 报告数字 / HEAD / 边界

| 判据 | 实测值 | 结果 |
|---|---|---|
| `package.json` version | `2.8.1` | ✓ |
| `manifest.webmanifest` version | `2.8.1` | ✓ |
| `sw.js` `VERSION` | `2.8.1` | ✓ |
| `index.html` `app-version` 徽标 | `v2.8.1` | ✓ |
| `CHANGELOG.md` | 含 `## [2.8.1] - 2026-11-04` | ✓ |
| `README.md` L52/L53 | `单元 494 项` / `E2E 15 套件 231 项` | ✓ |
| `reports/acceptance.json` | `verdict=PASS`, `unitAssertions=494`, `e2e={pass:231, fail:0, total:231, suites:15}`, `problems=[]` | ✓ |
| 数字一致性 | 494 / 15 / 231 三处（README ↔ acceptance）一致 | ✓ |
| HEAD | `31075fbcefa1b0c604a82cc1abdabfe830b3f192` = 远端 main（release-sync 通报） | ✓ |
| 引擎零 diff | `git diff --stat HEAD -- js/engine/ js/core/game.js` → 空 | ✓ |
| 生产目录根绝对路径 | `js/**/*.js` 中 `/js/` 根绝对引用 0 处；`index.html` 0 处 | ✓ |
| 工作区 | `git status --short` 仅有 `tests/qa/` 下 QA 自身产物（见 §6），产品代码无 M | ✓ |

---

## 3. 独立交叉验证：494 / 231 不是「纸面数字」

未重跑会写报告的 accept/E2E，改用只读 + 纯执行方式独立求证：

**单元 494 的构成（实测）**

- `npm test`（`package.json` scripts 中 8 套）实跑输出：

```
engine 39 / forbidden 45 / vcf 28 / vcf-practice 110 / search 36
loadorder 22（浏览器装配守护）/ tunable 48 / replay 30   → 合计 358 项
```

- 独立执行 `npm test` **未覆盖**的 4 套：

```
daily-wrongbook 32 / custom-timed 33 / tss 39 / threat-ai 32   → 合计 136 项
（tss 实测 534715 节点 / 4023ms，节点数确定，flaky 修复有效）
```

- `358 + 136 = 494`，与 `reports/acceptance.json.unitAssertions` 精确吻合；
- `tests/accept.js:28` 的 `unitSets` 确为 12 套，与 `tests/engine/*.test.js` 的 12 个文件一一对应。

**E2E 231 / 15 套件（静态佐证，未重跑）**

- `tests/e2e/run.js:10-15` 的 `SUITES` 数组实为 15 个（`01-load` … `15-vct`）；
- `reports/e2e.json`：`pass=231, fail=0, total=231`；
- `reports/acceptance.json.e2e`：`suites=15, pass=231, fail=0`；三者互相自洽。

> 声明：E2E 本轮**未重跑**，理由见 §1.1。本报告的 E2E 结论来自「既有闸门报告 + 套件清单静态核对」，不等同于本轮独立重跑；若需完全独立的 E2E 证据，请 team-lead 决定是否允许重跑（会重写 `reports/*.json`）。Round 2 曾由我独立跑过当时的 9 套件 67 条全绿。

---

## 4. 观察项（不阻塞发布，仅报告、不自行修）

- **O-1（P2，文档/脚本口径不符）**：`README.md:52` 写作
  `npm test  # 单元 494 项（engine / … / daily-wrongbook / custom-timed / tss / threat-ai）`（列了 12 套），
  但 `package.json:8` 的 `test` 脚本**只含 8 套**，实测仅 **358 项**；494 实为 `npm run accept` 的口径。
  执行者若按 README 跑 `npm test` 期望看到 494 会不符。建议二选一：把 4 套补进 `test` 脚本，或把 L52 改为 358 并把 494 归到 `npm run accept`。
  **不影响** §2 步骤 4 的「数字一致性」判定（494/15/231 三处数值确实一致），仅命令与注释错配。

- **O-2（P3，注释过时）**：`tests/accept.js:39` 注释仍为 `// 2. E2E（9 套件，真实 Edge）`，实际 `SUITES` 为 15 套件、231 项。纯注释，不影响执行。

- **O-3（P3，夹具边界，非产品缺陷）**：本次为让网络观测具备区分力，QA 服务对 `/sw.js` 返回 404 隔离了 Service Worker。因此「**SW 已激活且缓存命中时，Worker 路径是否仍正常**」这一组合**本次未实测**，报告不做推断。SW 本身的行为由 E2E `08-pwa` 套件覆盖（既有闸门全绿）。缓存命中只会减少网络请求，不改变 `new URL(..., currentScript.src)` 的解析逻辑，但仍如实列为未覆盖项。

---

## 5. 判定清单（28 项，全 PASS）

```
PASS  1 负向对照 via!==worker                 PASS  1b 负向对照 via===sync
PASS  1c 负向结果结构正常                     PASS  1d CDP 注入 404 确实命中 worker URL
PASS  1d2 服务端真实 HTTP 404 确实注入         PASS  1d3 服务端 404 通道也回退非 worker
PASS  1e 子路径负向 via!==worker              PASS  2 正常路径 via===worker
PASS  2b 正常结果结构正常                     PASS  2c reload 后 worker 被创建
PASS  2d 观测到 >=9 个 worker 侧请求           PASS  2e 观测到 9 个不同 worker 侧 URL
PASS  2f worker 侧零 4xx                     PASS  2g via 非常量(负向≠正向)
PASS  3 子路径 via===worker                   PASS  3b 子路径结果结构正常
PASS  3c 子路径 worker 侧请求带前缀            PASS  3d 子路径观测到 >=9 个 worker 侧请求
PASS  3e 子路径观测到 9 个不同 worker 侧 URL   PASS  3f 子路径 worker 侧零 4xx
PASS  4 四处版本源均 2.8.1                   PASS  4b CHANGELOG 含 2.8.1
PASS  4c README 与 acceptance 数字一致        PASS  4d 引擎零 diff
PASS  4e 生产 js 无 /js/ 根绝对路径           PASS  4f acceptance PASS 且问题 0
PASS  4g HEAD === 31075fb
```

`failedChecks = []`，`fatal = (none)`，`versionError = (none)`，脚本退出码 0。

### Round 记录（严格遵守 2 轮上限）

- **Round 1**：首轮 27 项中 1 项 FAIL（`1d 服务端确实注入 404`）。排查后确认是**QA 判定断言写窄**（CDP 在网络层之前 respond，请求未到服务端，但注入确实生效），属测试代码 bug → **QA 自修**，非源码 bug；同时把「服务端真实 HTTP 404」拆成独立负向通道实测。
- **Round 2**：修复后回归，28/28 全 PASS，退出码 0。无遗留失败项。

---

## 6. 产物与工作区

| 文件 | 说明 |
|---|---|
| `tests/qa/final-2.8.1-audit.js` | 独立验收脚本（可复现） |
| `tests/qa/final-2.8.1-audit.log` | 完整 trace（被 `.gitignore` 忽略） |
| `tests/qa/FINAL-2.8.1.md` | 本报告 |

`git status --short` 中属于本次验收的未跟踪项仅上述 QA 文件；产品源码、已有测试、配置**零改动**。这些 QA 文件是否纳入版本库由 team-lead 决定；若希望发布树保持纯净，删除即可，不影响被测代码。

---

## 7. 最终结论

**v2.8.1 通过 fresh-eyes 最终独立验收：PASS，建议发布线上版。`route = NoOne（交付）。`**

「Worker 静默回退被当成成功」这一风险已被负向对照 + 双场景（根 / 子路径）+ 9 请求零 4xx 的硬证据链排除；`via` 字段具备真实区分力，`workerBroken` 单例可经 reload 复位，版本源与验收数字全部对齐 `31075fb`。O-1 / O-2 / O-3 为不阻塞发布的文档与覆盖边界观察项，建议后续单独收口。
