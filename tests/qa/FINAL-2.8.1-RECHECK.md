# WebGoFive H5 v2.8.1 — 定稿后回归复核（QA 补充报告）

- 执行人：QA 严过关（Edward / software-qa-engineer）
- 复核时点：2026-11-04T13:21:07.802Z（脚本 `startedAt`）
- 复核基线：`31075fbcefa1b0c604a82cc1abdabfe830b3f192`（首次最终验收，见 `FINAL-2.8.1.md`）
- 复核对象：`7834fd1866faf03939d4bfa44a45ad8ada6f6e44`
  `chore: v2.8.1 收尾 —— 文档口径修正 + QA 最终验收报告入库`
- 复现命令：`QA_EXPECT_HEAD=7834fd1866faf03939d4bfa44a45ad8ada6f6e44 node tests/qa/final-2.8.1-audit.js`
- 机器可读证据：`tests/qa/final-2.8.1-audit.log`（本次）；`tests/qa/final-2.8.1-audit.31075fb.log`（基线时点备份）

> **本报告不回写 `FINAL-2.8.1.md`**。原报告是 13:08:44 / `31075fb` 时点的验收快照，保留其原始状态以维持审计轨迹；凡两处状态不一致，**以本补充报告为准**。

---

## 0. 触发原因与结论

release-sync 提醒：工作区出现 `README.md`、`tests/accept.js` 两个 M，是在修我上报的 O-1 / O-2，可能影响 `FINAL-2.8.1.md` 里「工作区状态」与「README 数字快照」的准确性。

只读核验后发现**状态已再次前进**：该修复已提交为 `7834fd1`，我复核时 `git status --short` 为空、工作区干净；我的 `FINAL-2.8.1.md` 与 `final-2.8.1-audit.js` 也已随该提交入库。因此本次按 release-sync 建议「以定稿后重跑为准」，在 `7834fd1` 上做完整回归复核。

**复核判定：PASS（29/29 判定项，failedChecks=[]，fatal=none，退出码 0）**
**发布建议：维持「可请用户发布线上版」；`route = NoOne（交付）`**

---

## 1. 定稿提交 `7834fd1` 到底改了什么

`git show --stat HEAD`：6 文件、646 insertions / 5 deletions。

| 文件 | 改动 | 性质 |
|---|---|---|
| `README.md` | L52 `npm test # 单元 494 项（12 套名单）` → `单元 358 项（8 套：…）`；L54 `npm run accept` → `唯一交付判据：单元 494 项（12 套）+ E2E 231 项 + …` | O-1 修复（文档口径） |
| `tests/accept.js` | 注释 `// 2. E2E（9 套件，真实 Edge）` → `（15 套件，真实 Edge）` | O-2 修复（注释） |
| `reports/acceptance.json` | 仅 `generatedAt` `12:42:47.730Z` → `13:16:49.951Z` | 闸门重新生成 |
| `reports/e2e.json` | 仅 `generatedAt` `12:42:47.674Z` → `13:16:49.864Z` | 闸门重新生成 |
| `tests/qa/FINAL-2.8.1.md` | 新增 219 行 | 我的验收报告入库 |
| `tests/qa/final-2.8.1-audit.js` | 新增 422 行 | 我的验收脚本入库 |

**关键事实：`git diff --stat 31075fb 7834fd1 -- js/ index.html sw.js manifest.webmanifest package.json CHANGELOG.md` 输出为空** —— 运行时代码、版本源、装配顺序自基线以来**零改动**。

`verdict / unitAssertions / e2e / problems` 全部未变：`PASS / 494 / {pass:231, fail:0, total:231, suites:15} / []`。

> 附带补强：`reports/acceptance.json` 与 `reports/e2e.json` 的 `generatedAt` 同步更新到 13:16:49，说明 `npm run accept`（含 E2E 15 套件）在定稿提交前被**完整重跑过且仍全绿**。这补上了 `FINAL-2.8.1.md` §3 中「E2E 本轮未重跑」的缺口。**如实声明**：该次重跑不是 QA 本人执行，QA 仅只读核对生成物；QA 本次亲自重跑的是下面的四步 Worker 专项验收。

---

## 2. 原报告中已过时的字段（以本补充为准）

| 原报告位置 | 原值（13:08:44 / 31075fb 时点，当时准确） | 现况（7834fd1） |
|---|---|---|
| §0 被测提交 | `31075fb…` | `7834fd1…` |
| §2 步骤 4 README 快照 | `单元 494 项` 挂在 `npm test` 行 | 双口径：`npm test` = 358（8 套）、`npm run accept` = 494（12 套） |
| §4 O-1 | 观察项「未修」 | **已修并关闭**（7834fd1） |
| §4 O-2 | 观察项「未修」 | **已修并关闭**（7834fd1） |
| §4 O-3 | SW 缓存命中 + Worker 组合未实测 | **仍未覆盖**，维持原状（夹具边界，非产品缺陷） |
| §6 工作区状态 | 仅 2 个 `??`，产品代码零 M | 复核开始时工作区干净；QA 文件已入库；本次复核后状态见 §6 |
| §7 / §0 数字一致性判据 | README 494 ↔ acceptance 494 | 现为 README `npm run accept` 494 ↔ acceptance 494 |

**新口径自洽性**：`npm test` 8 套 358 项 + 未覆盖的 4 套 136 项 = 494（`npm run accept` 12 套），与 `acceptance.json.unitAssertions = 494` 精确吻合；`E2E 15 套件 231 项` ↔ `e2e.suites=15 / total=231`。358 与 494 分属两个命令口径，不是数字冲突。

---

## 3. 我的 QA 脚本存在两处假阴性，已自行修复

复核前若直接复跑 `final-2.8.1-audit.js`，会产生**误报 FAIL**，两处都属 QA 工具设计缺陷，不是产品问题：

1. **`4c` README 数字判据**：原实现用 `npm test` 注释里的 `494` 去匹配 `acceptance.json` 的 494。O-1 修复后该行变成 `358`，`numbersConsistent` 会变 false。
   → 修为兼容单/双口径：优先取 `npm run accept` 行的「单元 N 项」与 acceptance 对齐，旧版单口径 README 自动回退到 `npm test` 行；同时把 `npmTestUnit` / `acceptUnit` 分别记录。
2. **`4g` HEAD 判据硬编码 `31075fb`**：后续任何提交都会 FAIL。
   → 改为 `QA_EXPECT_HEAD` 环境变量注入期望 SHA（由 team-lead / release-sync 通报），未注入时只校验 40 位 SHA 合法性；本次以 `QA_EXPECT_HEAD=7834fd1…` 跑，形成真实交叉断言。

另外**新增 `4h`：运行时代码自基线零改动**（`git diff --stat 31075fb HEAD -- js/ index.html sw.js manifest.webmanifest package.json CHANGELOG.md` 为空），使脚本能在后续任意提交上幂等复跑，而不是绑死某一时点。

以上仅改 `tests/qa/final-2.8.1-audit.js`（QA 自身文件），产品源码 / 已有测试 / 配置零改动。

---

## 4. 在 `7834fd1` 上重跑完整四步验收（实测，非推断）

**步骤 1 · 负向对照双通道**

| 场景 | A · CDP `respond(404)` | B · 服务端真实 HTTP 404 |
|---|---|---|
| root | `interceptionHits=1`，`via=sync`，结构正常，ranking 8 | `injected-404=1`，URL `/js/app/deep-eval-worker.js`，`via=sync`，结构正常 |
| subpath | `interceptionHits=1`，`via=sync`，结构正常 | `injected-404=1`，URL `/sub/path/js/app/deep-eval-worker.js`，`via=sync`，结构正常 |

**步骤 2 · 正常路径（域名根，显式 reload 清 `workerBroken`）**
`via=worker`，ranking 8；`workercreated` = `http://127.0.0.1:59307/js/app/deep-eval-worker.js`；
窗口内 **9 个请求 / 9 个不同 URL / 全部 200 / 零 4xx**；`pageErrors=[]`。

**步骤 3 · 子路径 `/sub/path/`（已实测）**
`via=worker`，ranking 8；`workercreated` = `http://127.0.0.1:60022/sub/path/js/app/deep-eval-worker.js`；
**9 个请求全部带 `/sub/path/` 前缀 / 全部 200 / 零 4xx**；`allUrlsHavePrefix=true`；`pageErrors=[]`。

**步骤 4 · 版本源 / 数字 / HEAD**
四处版本源仍均 `2.8.1`；CHANGELOG 含 `[2.8.1]`；README 新双口径（358 / 494 / 15 / 231）与 acceptance 一致（`numbersConsistent=true`）；`engineDiff` 空；生产 js 与 index.html 无 `/js/` 根绝对引用；`head = expectedHead = 7834fd1…`；`runtimeDiffSinceBaseline = (空 = 运行时零改动)`。

**判定清单：29/29 全 PASS**（原 28 项中 4c/4g 用修正后判据通过，新增 4h 通过），`failedChecks=[]`，退出码 0。

---

## 5. 观察项状态更新

| 编号 | 原状态 | 现状态 |
|---|---|---|
| O-1（README `npm test` 口径） | 待收口 | **已修复关闭**（7834fd1），双口径自洽 |
| O-2（`accept.js` 9 套件注释） | 待收口 | **已修复关闭**（7834fd1） |
| O-3（SW 已激活且缓存命中时 Worker 路径） | 未实测 | **仍未实测**，维持如实声明，不推断通过；SW 本身由 E2E `08-pwa` 覆盖 |

无新增阻塞项。

---

## 6. 工作区与同步提醒

- 复核开始时（7834fd1 定稿后）`git status --short` **为空**；release-sync 看到的 2 个 M 是提交前的中间态，已随 7834fd1 消失，属正常收口，**不是异常**。
- 本次复核后当前状态：
  - `M tests/qa/final-2.8.1-audit.js` —— 修复 4c/4g 假阴性 + 新增 4h（QA 工具维护）
  - `?? tests/qa/FINAL-2.8.1-RECHECK.md` —— 本补充报告
  - `tests/qa/final-2.8.1-audit.log` / `final-2.8.1-audit.31075fb.log` 被 `.gitignore:18 *.log` 忽略
  - **产品源码、已有测试、配置零改动**；是否把这两个 QA 文件补提交由 team-lead 决定。
- **给 release-sync 的提醒**：你此前通报远端 main = `31075fb`，而本地 HEAD 已前进到 `7834fd1`。若远端尚未包含该提交，请以 `7834fd1` 的新 tree 为准做增量同步与全量 blob 核验（尤其 README 双口径、`accept.js` 注释、两个报告的 `generatedAt` 与 QA 文件入库）；不要沿用 31075fb 的旧 blob 判据。

---

## 7. 复核结论

`7834fd1` 只改了文档口径、注释与报告时间戳，**运行时代码自 `31075fb` 零改动**；在此提交上重跑完整四步证伪验收仍 **29/29 PASS**，Worker 静默回退风险继续被排除，子路径继续实测成立，版本源与数字在新双口径下自洽。

**维持最终验收 PASS、建议发布线上版；`route = NoOne（交付）。`**
发布依据请合并阅读 `FINAL-2.8.1.md`（31075fb 时点快照）与本报告（7834fd1 复核），冲突处以本报告为准。
