/**
 * UI 控制器 —— 把「核心 + 渲染器 + AI」粘合成可玩界面
 *
 * 依赖（按 docs/API-CONTRACT.md）：
 *  - GMK.Game / GMK.Renderer / GMK.EngineAI
 *  - DOM：index.html 里的元素 id（board-canvas / hint-message / 模式按钮 等）
 *
 * 本层不碰引擎内部，只调 game / renderer 公开方法 + 订阅 game.on 事件。
 */
(function () {
    'use strict';

    const root = typeof globalThis !== 'undefined' ? globalThis : this;
    const GMK = root.GMK || (root.GMK = {});

    const DIFF_LABELS = { BEGINNER: '入门', NORMAL: '普通', HARD: '困难', HELL: '地狱' };
    /** 引擎 lastAIInfo.source → 中文标签（P0 诊断展示） */
    const SOURCE_LABELS = { search: '搜索', vcf: '算杀', blunder: '防亏', win: '成五', block: '挡五' };

    /** 棋盘坐标 → 象限记法（A1..O15） */
    function cxy(x, y) { return String.fromCharCode(65 + x) + (y + 1); }

    class App {
        constructor() {
            this.game = new GMK.Game();
            // P2-5：App 自建引擎并包一层可调参 AI（非 HELL 原样委托，
            // HELL + 自定义参数走 getBestMove 透传）。TunableAI 缺席时
            // 核心按默认懒加载 EngineAI，行为与 v2.1 一致。
            if (GMK.TunableAI && typeof GMK.TunableAI.createWrapper === 'function') {
                this.engineAI = new GMK.EngineAI(this.game);
                this.aiWrapper = GMK.TunableAI.createWrapper(this.engineAI);
                this.game.setAI(this.aiWrapper);
            }
            this.renderer = new GMK.Renderer(document.getElementById('board-canvas'));
            this.renderer.setVerbose(false);
            this.theme = localStorage.getItem('gmk_theme') || 'wood';
            this.renderer.setTheme(this.theme);
            document.body.setAttribute('data-theme', this.theme);

            this.aiThinking = false;
            this._aiPending = false;   // 已排期、尚未真正开算
            this._aiRaf = 0;           // 等待「玩家这一手上屏」的帧句柄
            this._aiTimer = 0;         // 让出主线程后的搜索启动定时器
            this.eveAutoPlay = false;
            this.showHint = true;      // AI 推荐点提示开关
            this.showThreat = true;    // 威胁点（对手成五位）高亮开关
            this._currentThreat = null;
            this._evaluating = false;
            this.strengthOverride = null; // P2-5：HELL 高级参数（生效值，镜像 aiWrapper.override）
            this.vcfStartTs = 0;       // VCF 练习开始时间戳
            this.vcfPuzzle = null;     // 当前 VCF 题
            this.vcf = null;           // 当前 VCF 会话（状态机）
            this._vcfTimer = 0;        // 看答案的演示定时器
            this.confirmMove = false;  // 落子需二次确认（防误触）
            this.soundOn = true;       // 落子音效
            this._pending = null;      // 待确认的落子
            this.cursor = null;        // 键盘光标
            this.tab = 'game';         // 侧栏当前分页：game / practice / analysis / settings
            this.reviewing = false;    // 是否处于复盘（棋盘由 Replayer 驱动）
            this.replayer = null;      // GMK.Replayer 实例
            this._timerId = 0;         // 计时器句柄

            this._init();
        }

        _$(id) { return document.getElementById(id); }
        _show(id, show) { const el = this._$(id); if (el) el.style.display = show ? '' : 'none'; }

        _init() {
            this._bindRenderer();
            this._bindGameEvents();
            this._bindControls();
            this._bindTabs();
            this._bindReplay();
            this._bindAIEnhance();
            this._bindUX();
            this._applySettingsFromStorage();
            this._hideLoading();
            this._updatePanelVisibility();
            this._startTimer();
        }

        _hideLoading() {
            const ls = this._$('loading-screen');
            if (ls) ls.classList.add('hidden');
        }

        _bindRenderer() {
            this.renderer.on('click', ({ x, y }) => this._onPlayerClick(x, y));
            this.renderer.on('hover', ({ x, y }) => {
                this._$('cursor-indicator') && (this._$('cursor-indicator').textContent =
                    x >= 0 && x < 15 ? String.fromCharCode(65 + x) + String(y + 1) : '—');
            });
        }

        _bindGameEvents() {
            this.game.on('move', ({ result }) => {
                this._render();
                if (result.gameOver) { this._render(); this._showResult(result); }
            });
            this.game.on('forbidden', ({ x, y, type }) => {
                this.renderer.setForbiddenPoint({ x, y });
                this._hint('⚠️ 禁手：' + type + '，请换位置');
                setTimeout(() => this.renderer.setForbiddenPoint(null), 1200);
            });
            this.game.on('over', () => { this.eveAutoPlay = false; });
        }

        _bindControls() {
            const bind = (id, fn) => { const el = this._$(id); if (el) el.addEventListener('click', fn); };
            bind('new-game-btn', () => this.newGame());
            bind('undo-btn', () => this.undo());
            bind('replay-btn', () => this._startReview());
            bind('close-result-btn', () => this.closeResultModal());

            // 模式切换
            for (const m of ['PvP', 'PvE', 'EvE']) {
                const el = this._$('mode-' + m);
                if (el) el.addEventListener('click', () => this.setMode(m));
            }
            // 难度
            for (const d of GMK.Game.DIFFS) {
                const el = this._$('diff-' + d);
                if (el) el.addEventListener('click', () => this.setDifficulty(d));
            }
            // 主题
            for (const t of ['wood', 'dark', 'light']) {
                const el = this._$('theme-' + t);
                if (el) el.addEventListener('click', () => this.setTheme(t));
            }
            // 坐标开关：用 checkbox.checked 作为唯一真相，并持久化
            // （旧实现用 classList.toggle('on') 推断状态，与 checked 反向，一开就错）
            const cc = this._$('toggle-coords');
            if (cc) {
                cc.checked = localStorage.getItem('gmk_coords') !== '0';
                this.renderer.setShowCoords(cc.checked);
                cc.addEventListener('change', () => {
                    this.renderer.setShowCoords(cc.checked);
                    localStorage.setItem('gmk_coords', cc.checked ? '1' : '0');
                });
            }
        }

        /* ---------------- 侧栏分页 ---------------- */

        _bindTabs() {
            for (const b of document.querySelectorAll('.ctrl-tab')) {
                b.addEventListener('click', () => this.showTab(b.dataset.tab));
            }
        }

        /** 切换侧栏分页；不传参数则按当前模式自动挑一个合适的页 */
        showTab(name) {
            if (!name) return;
            this.tab = name;
            for (const b of document.querySelectorAll('.ctrl-tab')) {
                const on = b.dataset.tab === name;
                b.classList.toggle('is-on', on);
                b.setAttribute('aria-selected', on ? 'true' : 'false');
            }
            for (const p of document.querySelectorAll('.ctrl-pane')) {
                p.classList.toggle('is-on', p.dataset.pane === name);
            }
        }

        /* ---------------- 手数列表 + 复盘 ---------------- */

        _bindReplay() {
            const ol = this._$('move-list');
            if (ol) {
                ol.addEventListener('click', e => {
                    const li = e.target.closest && e.target.closest('li.mv-item');
                    if (!li) return;
                    this._startReview(Number(li.dataset.i));
                });
            }
            const bind = (id, fn) => { const el = this._$(id); if (el) el.addEventListener('click', fn); };
            bind('rp-first', () => this.replayer && this.replayer.first());
            bind('rp-back', () => this.replayer && this.replayer.back());
            bind('rp-fwd', () => this.replayer && this.replayer.step());
            bind('rp-last', () => this.replayer && this.replayer.last());
            bind('rp-exit', () => this._exitReview());
            bind('rp-play', () => {
                const r = this.replayer, b = this._$('rp-play');
                if (!r) return;
                if (r.playing) { r.pause(); if (b) b.textContent = '▶'; }
                else { r.play(); if (b) b.textContent = '⏸'; }
            });
        }

        /**
         * 进入复盘：从当前 moves 重建 Replayer，并跳到第 idx 手。
         * 复盘期间棋盘由 Replayer 逐帧驱动，_render() 不再覆盖。
         */
        _startReview(idx) {
            const moves = this.game.getMoves();
            if (!moves.length) { this._hint('还没有落子，无法复盘'); return; }
            if (this.replayer) this.replayer.destroy();
            this.replayer = new GMK.Replayer(moves, {
                speed: 320,
                onFrame: (b, i) => this._reviewFrame(b, i)
            });
            this.reviewing = true;
            this._show('replay-player', true);
            // 手数列表要跟着复盘位置高亮，先把「对局」页切出来
            if (this.tab !== 'game') this.showTab('game');
            const b = this._$('rp-play');
            if (b) b.textContent = '▶';
            this.replayer.goto(typeof idx === 'number' ? idx : moves.length - 1);
        }

        _reviewFrame(board, idx) {
            const r = this.replayer;
            if (!r) return;
            const m = idx >= 0 ? r.moves[idx] : null;
            this.renderer.render(board, {
                lastMove: m ? { x: m.x, y: m.y, player: m.player } : null,
                threat: null
            });
            const pos = this._$('rp-pos');
            if (pos) pos.textContent = (idx + 1) + ' / ' + r.total;
            if (!r.playing) { const b = this._$('rp-play'); if (b) b.textContent = '▶'; }
            this._highlightMove(idx);
        }

        _exitReview() {
            if (!this.reviewing) return;
            this.reviewing = false;
            if (this.replayer) this.replayer.pause();
            this._show('replay-player', false);
            this._render();
        }

        /** 重绘手数列表（仅当手数变化才重建 DOM，保住滚动位置） */
        _paintMoveList() {
            const ol = this._$('move-list');
            if (!ol) return;
            const moves = this.game.getMoves();
            const cnt = this._$('mv-count');
            if (cnt) cnt.textContent = moves.length + ' 手';

            if (ol._n !== moves.length) {
                if (!moves.length) {
                    ol.innerHTML = '<li class="mv-empty">还没有落子</li>';
                } else {
                    let html = '';
                    for (let i = 0; i < moves.length; i++) {
                        const m = moves[i];
                        html += '<li class="mv-item" data-i="' + i + '">' +
                            '<span class="mv-no">' + (i + 1) + '</span>' +
                            '<span class="mv-dot ' + (m.player === 1 ? 'b' : 'w') + '"></span>' +
                            '<span class="mv-pt">' + cxy(m.x, m.y) + '</span></li>';
                    }
                    ol.innerHTML = html;
                }
                ol._n = moves.length;
                ol.scrollTop = ol.scrollHeight;
            }

            const cur = this.reviewing && this.replayer
                ? this.replayer.idx
                : moves.length - 1;
            this._highlightMove(cur);
        }

        _highlightMove(idx) {
            const ol = this._$('move-list');
            if (!ol) return;
            for (const li of ol.querySelectorAll('li.mv-item')) {
                li.classList.toggle('is-cur', Number(li.dataset.i) === idx);
            }
            const cur = ol.querySelector('li.is-cur');
            if (cur) {
                ol.scrollTop = Math.max(0, cur.offsetTop - ol.clientHeight / 2 + cur.offsetHeight / 2);
            }
        }

        /* ---------------- 对局计时 ---------------- */

        _startTimer() {
            if (this._timerId) return;
            this._timerId = setInterval(() => this._paintTimer(), 1000);
        }

        _paintTimer() {
            const el = this._$('elapsed');
            if (!el) return;
            const d = this.game.getGameInfo().duration || 0;
            const s = Math.floor(d / 1000);
            el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' +
                String(s % 60).padStart(2, '0');
        }

        /* ---------------- 操作逻辑（以人为本） ---------------- */

        /** 认输 / 棋谱导入导出 / 落子确认 / 音效 / 战绩 */
        _bindUX() {
            const bind = (id, fn) => { const el = this._$(id); if (el) el.addEventListener('click', fn); };

            // 先读偏好，再初始化控件，避免勾选状态与真实设置不一致
            this.confirmMove = localStorage.getItem('gmk_confirm') === '1';
            this.soundOn = localStorage.getItem('gmk_sound') !== '0';

            bind('resign-btn', () => this.resign());
            bind('btn-export', () => this.exportRecord());
            bind('btn-import', () => this.importRecord());

            const cf = this._$('toggle-confirm');
            if (cf) {
                cf.checked = !!this.confirmMove;
                cf.addEventListener('change', () => {
                    this.confirmMove = !!cf.checked;
                    this._pending = null;
                    this.renderer.setPending(null);
                    localStorage.setItem('gmk_confirm', this.confirmMove ? '1' : '0');
                    this._hint(this.confirmMove ? '落子需二次确认（防误触）' : '落子即时生效');
                });
            }

            const sd = this._$('toggle-sound');
            if (sd) {
                sd.checked = !!this.soundOn;
                sd.addEventListener('change', () => {
                    this.soundOn = !!sd.checked;
                    localStorage.setItem('gmk_sound', this.soundOn ? '1' : '0');
                    if (this.soundOn) this._beep(660, 0.08);
                });
            }

            this._paintStats();
        }

        /** 极简音效：WebAudio 合成，不引入任何音频资源 */
        _beep(freq, dur) {
            if (!this.soundOn) return;
            try {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return;
                if (!this._ac) this._ac = new AC();
                const ac = this._ac;
                if (ac.state === 'suspended') ac.resume();
                const o = ac.createOscillator(), g = ac.createGain();
                o.type = 'sine';
                o.frequency.value = freq;
                o.connect(g); g.connect(ac.destination);
                const t = ac.currentTime;
                g.gain.setValueAtTime(0.0001, t);
                g.gain.exponentialRampToValueAtTime(0.07, t + 0.01);
                g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.09));
                o.start(t); o.stop(t + (dur || 0.09) + 0.02);
            } catch (e) { /* 音频不可用不影响对局 */ }
        }

        /* --- 战绩 --- */
        _loadStats() {
            try { return JSON.parse(localStorage.getItem('gmk_stats') || '{}') || {}; } catch (e) { return {}; }
        }
        _paintStats() {
            const el = this._$('stat-line');
            if (!el) return;
            const st = this._loadStats();
            if (!st.total) { el.textContent = '战绩：—'; return; }
            const rate = Math.round((st.win || 0) / st.total * 100);
            el.textContent = '战绩：' + (st.win || 0) + ' 胜 ' + (st.lose || 0) + ' 负 ' +
                (st.draw || 0) + ' 和 · 胜率 ' + rate + '%' +
                (st.streak ? ' · 连胜 ' + st.streak : '');
        }
        /** 只统计人机对战（玩家执黑），PvP / EvE 不计入 */
        _recordResult(winner) {
            if (this.game.gameMode !== 'PvE') return;
            const st = this._loadStats();
            st.total = (st.total || 0) + 1;
            if (winner === 0) { st.draw = (st.draw || 0) + 1; st.streak = 0; }
            else if (winner === 1) {
                st.win = (st.win || 0) + 1;
                st.streak = (st.streak || 0) + 1;
                st.best = Math.max(st.best || 0, st.streak);
            } else { st.lose = (st.lose || 0) + 1; st.streak = 0; }
            try { localStorage.setItem('gmk_stats', JSON.stringify(st)); } catch (e) {}
            this._paintStats();
        }

        /* --- 认输 --- */
        resign() {
            const g = this.game;
            if (g.gameStatus === 'finished') { this._hint('对局已经结束了'); return; }
            if (g.gameMode === 'EvE') { this._hint('机机对战没有认输'); return; }
            const loser = g.gameMode === 'PvE' ? 1 : g.currentPlayer;
            const winner = loser === 1 ? 2 : 1;
            g.winner = winner;
            g.gameStatus = 'finished';
            g.endTime = Date.now();
            this._hint((loser === 1 ? '黑方' : '白方') + '认输');
            this._showResult({ winner: winner, winLine: null, reason: 'resign' });
        }

        /* --- 棋谱导出 / 导入（纯文本坐标，如 "H8 I9 H7"） --- */
        exportRecord() {
            const moves = this.game.getMoves();
            const box = this._$('record-box');
            const text = moves.map(m => cxy(m.x, m.y)).join(' ');
            if (box) {
                box.value = text;
                if (box.select) box.select();
            }
            this._hint(moves.length ? '已生成棋谱（' + moves.length + ' 手），可复制保存' : '本局还没有落子');
        }

        importRecord() {
            const box = this._$('record-box');
            const text = box ? String(box.value || '') : '';
            const tokens = text.trim().split(/[\s,;，；]+/).filter(Boolean);
            if (!tokens.length) { this._hint('请先粘贴棋谱，如：H8 I9 H7'); return; }

            const moves = [];
            for (const tk of tokens) {
                const m = /^([A-Oa-o])(\d{1,2})$/.exec(tk);
                if (!m) { this._hint('棋谱格式不对：' + tk); return; }
                const x = m[1].toUpperCase().charCodeAt(0) - 65;
                const y = parseInt(m[2], 10) - 1;
                if (y < 0 || y > 14) { this._hint('坐标越界：' + tk); return; }
                moves.push({ x: x, y: y });
            }

            this.setMode('PvP', true);
            this.newGame();
            let n = 0;
            for (const mv of moves) {
                const r = this.game.placePiece(mv.x, mv.y);
                if (!r.success) { this._hint('第 ' + (n + 1) + ' 手无法落子（' + cxy(mv.x, mv.y) + '）'); break; }
                n++;
                if (r.gameOver) break;
            }
            this._render();
            this._hint('已导入 ' + n + ' 手' + (n < moves.length ? '（后续有非法着法已截断）' : ''));
        }

        _applySettingsFromStorage() {
            const mode = localStorage.getItem('gmk_mode');
            if (mode && GMK.Game.MODES.includes(mode)) this.setMode(mode, true);
            const diff = localStorage.getItem('gmk_diff');
            if (diff && GMK.Game.DIFFS.includes(diff)) this.setDifficulty(diff, true);
            const theme = localStorage.getItem('gmk_theme');
            if (theme) this.setTheme(theme, true);
        }

        /* ---------------- AI 增强（T4：分析面板 + 威胁高亮 + VCF 面板） ---------------- */

        /** 绑定 AI 分析面板 / 威胁开关 / 深度评估 / VCF 练习（全部 DOM 可选） */
        _bindAIEnhance() {
            // 深度评估按钮（同步搜索会卡主线程，必须先上屏遮罩再跑，见设计 §7）
            const deep = this._$('btn-deep-eval');
            if (deep) deep.addEventListener('click', () => this._runDeepEval());

            // P2-5：HELL 高级棋力选项面板
            this._bindStrengthAdvanced();

            // 最优着法提示开关 / 威胁提示开关
            const ht = this._$('chk-hint-toggle');
            if (ht) ht.addEventListener('change', () => {
                this.showHint = !!ht.checked;
                this._refreshAIOverlays();
            });
            const tt = this._$('chk-threat-toggle');
            if (tt) tt.addEventListener('change', () => {
                this.showThreat = !!tt.checked;
                this._refreshAIOverlays();
            });

            // VCF 连冲练习：按难度分组的下拉 + 开始 / 提示 / 悔一步 / 重来 / 看答案
            const V = GMK.VCFPractice;
            const sel = this._$('vcf-puzzle-select');
            if (sel && V && Array.isArray(V.PUZZLES)) {
                for (let lv = 0; lv < V.LEVELS.length; lv++) {
                    const level = V.LEVELS[lv];
                    const group = document.createElement('optgroup');
                    group.label = level.name;
                    let n = 0;
                    for (let i = 0; i < V.PUZZLES.length; i++) {
                        const p = V.PUZZLES[i];
                        if (p.level !== level.id) continue;
                        const opt = document.createElement('option');
                        opt.value = String(i);
                        opt.textContent = p.title + ' · ' + p.depth + ' 手';
                        group.appendChild(opt);
                        n++;
                    }
                    if (n) sel.appendChild(group);
                }
                this._vcfUpdate();
            }
            const bindVcf = (id, fn) => {
                const el = this._$(id);
                if (el) el.addEventListener('click', () => { this._vcfStopDemo(); fn.call(this); });
            };
            bindVcf('btn-vcf-start', this._startVcf);
            bindVcf('btn-vcf-hint', this._vcfHint);
            bindVcf('btn-vcf-undo', this._vcfUndo);
            bindVcf('btn-vcf-restart', this._vcfRestart);
            bindVcf('btn-vcf-solution', this._vcfSolution);

            // 每步落子后：填 #ai-best-move + 威胁扫描 + 优势条（P0/P1）
            this.game.on('move', () => this._onMoveAfterHook());
            // 终局：清除威胁高亮 / 提示
            this.game.on('over', () => this._clearAIOverlays());
            // 棋盘被重置（含外部直接调用 reset() 的测试/工具场景）：
            // 立刻中止 EvE 自动对局链，避免已排队的单步继续往空盘上落子。
            // newGame() 内部先置 false 再 reset，随后由 _startEvE() 重新拉 true，
            // 故不会误伤正常「新对局」流程。
            this.game.on('reset', () => { this.eveAutoPlay = false; this._cancelAIThink(); });
        }

        /** 落子事件钩子：AI 分析 + 威胁高亮 + VCF 完成判定 */
        _onMoveAfterHook() {
            const g = this.game;
            const board = g.getBoardState();

            // ① VCF 练习：判定完全交给会话状态机（_vcfPlay / VcfSession.play），
            //    这里不再做「是否成五」的粗判，否则会把「走错但碰巧成五」也算通过。
            if (g.gameMode === 'VCF_PRACTICE') return;

            if (g.gameStatus === 'finished') { this._clearAIOverlays(); return; }
            if (!GMK.Analysis) return;

            // ② 威胁点：「对手」= 刚落子方（视角 = 当前行棋方的对手）
            if (this.showThreat && g.gameMode !== 'VCF_PRACTICE') {
                const justMoved = g.currentPlayer === 1 ? 2 : 1;
                this._currentThreat = GMK.Analysis.scanOpponentThreat(board, justMoved);
            } else {
                this._currentThreat = null;
            }

            // ③ 优势条（浅搜 200ms，设计 P1 轻量档；EvE 面板隐藏，跳过省主线程）
            if (g.gameMode !== 'EvE') {
                try {
                    this._paintAdvantage(GMK.Analysis.advantage(board, g.currentPlayer));
                } catch (e) { /* 分析层异常不阻塞对局 */ }
            }

            // ④ 分析面板：开局窗口（盘面 < 4 子）内优先显示定式推荐（P2-6）；
            //    出窗后 PvE 展示 AI 应招诊断（lastAIInfo 对应 AI 那手）
            if (!this._maybeOpeningRec() && g.gameMode === 'PvE') this._paintAIInfo(g.lastAIInfo);

            // 让新威胁态立即上屏（首 handler 已渲染一次，这里补一次以反映 threat）
            this._render();
        }

        /** 把引擎诊断（lastAIInfo）写进 #ai-best-move / #ai-source / #ai-diagnostics */
        _paintAIInfo(info) {
            const C = GMK.C;
            const bestEl = this._$('ai-best-move');
            // ⚠ 引擎契约：info.move 是「填充索引」（Int8 一维下标），
            // 必须用 C.xOf / C.yOf 翻译成棋盘坐标（共享知识 §6）
            if (!info || !C || info.move == null || info.move < 0 || !C.inBoard(info.move)) {
                if (bestEl) bestEl.textContent = '—';
                return;
            }
            const x = C.xOf(info.move), y = C.yOf(info.move);
            if (bestEl) bestEl.textContent = cxy(x, y) + ' (' + x + ',' + y + ')';
            const srcEl = this._$('ai-source');
            if (srcEl) srcEl.textContent = SOURCE_LABELS[info.source] || String(info.source || '');
            const diagEl = this._$('ai-diagnostics');
            if (diagEl) diagEl.textContent = 'depth ' + (info.depth || 0) + ' / ' +
                (info.nodes || 0) + ' 节点 / ' + (info.timeMs || 0) + 'ms';
            // 提示开关：在棋盘上画出 AI 推荐点（不覆盖落子）
            if (this.showHint) {
                this.renderer.setHint({ x: x, y: y });
                setTimeout(() => this.renderer.clearHint(), 1500);
            }
        }

        /** 优势条：黑/白/均势 渐变填充 */
        _paintAdvantage(adv) {
            const label = this._$('adv-label'), fill = this._$('adv-fill');
            if (!label || !fill) return;
            label.textContent = adv.side === 'black' ? '黑方领先' : adv.side === 'white' ? '白方领先' : '均势';
            label.className = 'adv-tag' + (adv.side === 'black' ? ' is-black' : adv.side === 'white' ? ' is-white' : '');
            // score 为黑视角：正=黑领先。填充分宽度=黑方份额，±48% 内线性
            const ratio = Math.max(-48, Math.min(48, (adv.score / 1000000) * 48));
            fill.style.width = Math.round(50 + ratio) + '%';
        }

        /* ---------------- P2-5：HELL 高级棋力选项 ---------------- */

        /** 绑定高级参数面板（DOM 可选，全部缺席时静默跳过） */
        _bindStrengthAdvanced() {
            const T = GMK.TunableAI;
            if (!T) return;
            const onChange = () => this._applyStrengthInputs();
            for (const id of ['adv-time', 'adv-depth', 'adv-cand']) {
                const el = this._$(id);
                if (el) el.addEventListener('change', onChange);
            }
            const rst = this._$('btn-strength-reset');
            if (rst) rst.addEventListener('click', () => {
                this._setStrengthInputs(T.defaults());
                this._applyStrengthInputs();
                this._hint('高级强度已恢复引擎默认');
            });
            // 恢复上次的自定义参数；无存档时输入框显示引擎默认
            let saved = null;
            try { saved = JSON.parse(localStorage.getItem('gmk_strength_hell') || 'null'); } catch (e) { saved = null; }
            if (saved) {
                this._setStrengthInputs(T.sanitize(saved));
                this._applyStrengthInputs(true);
            } else {
                this._setStrengthInputs(T.defaults());
            }
        }

        _setStrengthInputs(v) {
            const map = { 'adv-time': v.timeMs, 'adv-depth': v.depth, 'adv-cand': v.candidates };
            for (const id in map) {
                const el = this._$(id);
                if (el) el.value = String(map[id]);
            }
        }

        /** 读输入框 → sanitize → 注入包装 AI + 持久化（等于引擎默认则自动清空） */
        _applyStrengthInputs(silent) {
            const T = GMK.TunableAI;
            if (!T || !this.aiWrapper) return;
            const v = T.sanitize({
                timeMs: parseFloat(this._$('adv-time') && this._$('adv-time').value),
                depth: parseFloat(this._$('adv-depth') && this._$('adv-depth').value),
                candidates: parseFloat(this._$('adv-cand') && this._$('adv-cand').value)
            });
            this.strengthOverride = this.aiWrapper.setOverride(v);
            if (this.strengthOverride) localStorage.setItem('gmk_strength_hell', JSON.stringify(this.strengthOverride));
            else localStorage.removeItem('gmk_strength_hell');
            if (!silent) this._hint('高级强度：' + v.timeMs + 'ms / ' + v.depth + ' 层 / ' + v.candidates + ' 候选');
        }

        /* ---------------- P2-6：开局定式推荐 ---------------- */

        /**
         * 开局窗口（盘面 < 4 子）内给当前行棋方推荐定式点：填分析面板
         * 「AI 推荐 / source=开局」，并复用 P0 的 hint 渲染通道（1.5s 高亮）。
         * @returns {boolean} 是否处于开局窗口并已绘制推荐
         */
        _maybeOpeningRec() {
            const g = this.game;
            if (!GMK.Analysis || typeof GMK.Analysis.openingRecommendation !== 'function') return false;
            if (g.gameStatus === 'finished') return false;
            if (g.gameMode === 'EvE' || g.gameMode === 'VCF_PRACTICE') return false;
            if (g.moves.length >= 4) return false;
            const rec = GMK.Analysis.openingRecommendation(g.getBoardState(), g.currentPlayer);
            if (!rec) return false;
            const bestEl = this._$('ai-best-move'), srcEl = this._$('ai-source'), diagEl = this._$('ai-diagnostics');
            if (bestEl) bestEl.textContent = cxy(rec.x, rec.y) + ' (' + rec.x + ',' + rec.y + ')';
            if (srcEl) srcEl.textContent = '开局';
            if (diagEl) diagEl.textContent = '开局定式推荐 · 前 4 手（已落 ' + rec.stones + ' 子）';
            if (this.showHint) {
                this.renderer.setHint({ x: rec.x, y: rec.y });
                setTimeout(() => this.renderer.clearHint(), 1500);
            }
            return true;
        }

        /** 手动深度评估：遮罩上屏 → 同步搜索（默认 500ms 上限）→ 画前 3 条变例 */
        _runDeepEval() {
            const g = this.game;
            if (!GMK.Analysis || g.gameStatus === 'finished' || this._evaluating) return;
            this._evaluating = true;
            const mask = this._$('ai-thinking');
            if (mask) { mask.textContent = 'AI 计算中…'; this._show('ai-thinking', true); }
            // 同步调用会卡主线程：先让遮罩上屏一帧再开搜（HELL 下 500ms 仍可能久，已限默认 500ms）
            setTimeout(() => {
                try {
                    const res = GMK.Analysis.evaluate(g.getBoardState(), g.currentPlayer,
                        { timeMs: 500, depth: 8, candidates: 10 });
                    this._paintDeepEval(res);
                } catch (e) {
                    this._hint('深度评估失败：' + (e && e.message || e));
                } finally {
                    if (mask) mask.textContent = 'AI 思考中…';
                    this._show('ai-thinking', false);
                    this._evaluating = false;
                }
            }, 30);
        }

        /** 把 evaluate 结果画进面板：最优着法 + 诊断 + 主要变例（前 3） */
        _paintDeepEval(res) {
            const bestEl = this._$('ai-best-move'), srcEl = this._$('ai-source');
            const diagEl = this._$('ai-diagnostics'), pvEl = this._$('ai-pv-list');
            const b = res.best;
            if (bestEl) {
                bestEl.textContent = (b && b.x >= 0)
                    ? cxy(b.x, b.y) + ' (' + b.x + ',' + b.y + ')' : '—';
            }
            if (srcEl) srcEl.textContent = SOURCE_LABELS[res.source] || String(res.source || '搜索');
            if (diagEl && b) diagEl.textContent = 'depth ' + b.depth + ' / ' + b.nodes +
                ' 节点 / ' + b.timeMs + 'ms';
            if (pvEl) {
                pvEl.textContent = '';
                for (let i = 0; i < Math.min(3, res.ranking.length); i++) {
                    const r = res.ranking[i];
                    const li = document.createElement('li');
                    li.textContent = (i + 1) + '. ' + cxy(r.x, r.y) + ' · ' +
                        (r.score >= 50000 ? '强' : r.score > 0 ? '优' : '平');
                    pvEl.appendChild(li);
                }
            }
            if (this.showThreat && b && b.x >= 0) this._currentThreat = null; // 评估后重扫
            this._refreshAIOverlays();
        }

        /** 威胁开关 / 提示开关变化 → 立即重渲染棋盘 */
        _refreshAIOverlays() {
            this._render();
        }

        /* ---------------- VCF 连冲练习 ---------------- */

        /** 选题 → 建会话 → 载入棋盘 → 切 VCF_PRACTICE 模式 */
        _startVcf() {
            const V = GMK.VCFPractice;
            if (!V || !V.create) return;
            const sel = this._$('vcf-puzzle-select');
            const idx = sel ? (parseInt(sel.value, 10) || 0) : 0;
            const p = V.PUZZLES[idx];
            if (!p) return;

            this.vcf = V.create(idx);
            this.vcf.startedAt = Date.now();
            this.vcfPuzzle = p;
            this.vcfStartTs = Date.now();

            this.game.setGameMode('VCF_PRACTICE');
            this._vcfSync();
            this._updatePanelVisibility();
            this._vcfUpdate();
            this._hint('VCF 连冲：' + p.title + ' —— ' + p.lesson);
        }

        /** 把会话棋盘同步到真实 game 上（渲染 / 最后一手标记的唯一入口） */
        _vcfSync() {
            const s = this.vcf;
            if (!s) return;
            this.game.loadCustomState({
                board: s.board2d,
                currentPlayer: 1,
                gameStatus: s.state === 'solved' ? 'finished' : 'playing'
            });
            this.renderer.setWinLine(null);
            const last = s.lastMove;
            if (last) {
                this.renderer.setHint({ x: last.x, y: last.y });
                setTimeout(() => this.renderer.clearHint(), 700);
            } else {
                this.renderer.clearHint();
            }
            this._render();
        }

        /** 面板状态刷新：进度条 / 手数 / 提示文案 */
        _vcfUpdate(msg, kind) {
            const s = this.vcf;
            const p = this.vcfPuzzle;
            const set = (id, text) => { const el = this._$(id); if (el) el.textContent = text; };
            const msgEl = this._$('vcf-status');
            const fill = this._$('vcf-bar-fill');

            const total = GMK.VCFPractice.PUZZLES.length;
            set('vcf-count', GMK.VCFPractice.solvedCount() + '/' + total);

            if (!s || !p) {
                set('vcf-level', '未开始');
                set('vcf-depth', '目标 — 手');
                set('vcf-steps', '已走 0 手');
                if (fill) fill.style.width = '0%';
                if (msgEl) { msgEl.textContent = msg || '选一道题开始。'; msgEl.className = 'vcf-msg'; }
                return;
            }

            set('vcf-level', p.levelName + ' · ' + p.title);
            set('vcf-depth', '目标 ' + p.depth + ' 手');
            set('vcf-steps', '已走 ' + s.steps + ' 手');

            const lv = this._$('vcf-level');
            if (lv) lv.classList.add('is-on');

            const pct = s.state === 'solved' ? 100 : Math.min(99, Math.round(s.steps / Math.max(1, p.depth) * 100));
            if (fill) fill.style.width = pct + '%';

            if (msgEl) {
                if (msg) {
                    msgEl.textContent = msg;
                    msgEl.className = 'vcf-msg' + (kind ? ' is-' + kind : '');
                } else if (s.state === 'solved') {
                    const ms = s.elapsed;
                    // 只在首次通关时写记录，避免每次刷新面板都累加 times
                    if (!s._recorded) { s._recorded = true; GMK.VCFPractice.record(p.id, ms, s.steps); }
                    const rec = GMK.VCFPractice.getRecord(p.id) || { ms: ms };
                    msgEl.textContent = '已解 · ' + s.steps + ' 手 · 用时 ' + (ms / 1000).toFixed(1) + 's · 最佳 ' +
                        (rec.ms / 1000).toFixed(1) + 's';
                    msgEl.className = 'vcf-msg is-ok';
                } else if (s.state === 'failed') {
                    msgEl.textContent = '这条线走死了 —— 后面没有连冲了。悔一步或重来。';
                    msgEl.className = 'vcf-msg is-bad';
                } else {
                    msgEl.textContent = '轮到你（黑）。每一手都必须是冲四。';
                    msgEl.className = 'vcf-msg';
                }
            }
        }

        /** 玩家在练习模式下落子 */
        _vcfPlay(x, y) {
            const s = this.vcf;
            if (!s || s.state !== 'playing') { this._hint('先点「开始」载入一道题'); return; }
            const r = s.play(x, y);

            if (r.code === 'NOT_FOUR') {
                this._vcfUpdate('这一手不是冲四 —— 对方不必应，攻击链就断了。想想哪里能形成四。', 'bad');
                this._hint('不是冲四：对方没有必须应的一手');
                return;
            }
            if (r.code === 'OCCUPIED') { this._hint('这里已经有子了'); return; }

            this._vcfSync();

            if (r.code === 'FOUR') {
                if (r.dead) {
                    this._vcfUpdate('对方应手之后，你已无冲四可走 —— 这条线不成立。', 'bad');
                } else {
                    const nm = GMK.VCFPractice.name(r.reply);
                    this._vcfUpdate('冲四成立，对方被迫挡 ' + nm + '。继续找下一个四。', 'ok');
                }
            } else if (r.code === 'DOUBLE') {
                this._vcfUpdate();
                this._hint('活四 / 双四！对方挡不住两端 —— 连冲完成');
            } else if (r.code === 'WIN') {
                this._vcfUpdate();
                this._hint('五连！连冲完成');
            }
        }

        _vcfHint() {
            const s = this.vcf;
            if (!s || s.state !== 'playing') return;
            const h = s.hint();
            if (!h) { this._vcfUpdate('这个局面已经没有连冲了，悔一步试试。', 'bad'); return; }
            this.renderer.setHint({ x: h.x, y: h.y });
            setTimeout(() => this.renderer.clearHint(), 1500);
            this._vcfUpdate('提示：' + GMK.VCFPractice.name(h) + ' 可以形成冲四。', '');
        }

        _vcfUndo() {
            const s = this.vcf;
            if (!s) return;
            if (!s.undo()) { this._vcfUpdate('没有可撤的回合了。', ''); return; }
            this._vcfSync();
            this._vcfUpdate('已悔一步。', '');
        }

        _vcfRestart() {
            if (!this.vcfPuzzle) return;
            const idx = GMK.VCFPractice.indexOf(this.vcfPuzzle.id);
            const sel = this._$('vcf-puzzle-select');
            if (sel && idx >= 0) sel.value = String(idx);
            this._startVcf();
        }

        /** 看答案：把参考连冲线逐步演一遍（每步 550ms，可被新动作打断） */
        _vcfSolution() {
            const s = this.vcf;
            if (!s) return;
            const line = s.solution();
            if (!line.length) { this._vcfUpdate('这道题当前局面算不出连冲线。', 'bad'); return; }

            const idx = GMK.VCFPractice.indexOf(this.vcfPuzzle.id);
            const fresh = GMK.VCFPractice.create(idx);
            this.vcf = fresh;
            this._vcfSync();
            this._vcfUpdate('演示参考线：' + line.length + ' 手连冲。', '');

            let k = 0;
            const timer = setInterval(() => {
                if (k >= line.length || this.vcf !== fresh) { clearInterval(timer); return; }
                const step = line[k++];
                fresh.play(step.black.x, step.black.y);
                this._vcfSync();
                this._vcfUpdate('参考线 第 ' + k + ' 手：' + GMK.VCFPractice.name(step.black) +
                    (step.white ? ' → 对方挡 ' + GMK.VCFPractice.name(step.white) : ' → 成五'), '');
            }, 550);
            this._vcfTimer = timer;
        }

        _vcfStopDemo() {
            if (this._vcfTimer) { clearInterval(this._vcfTimer); this._vcfTimer = 0; }
        }

        /** 终局 / 新对局：清除威胁高亮、变例与诊断 */
        _clearAIOverlays() {
            this._currentThreat = null;
            this.renderer.clearHint();
            const pv = this._$('ai-pv-list');
            if (pv) pv.textContent = '';
            const bestEl = this._$('ai-best-move');
            if (bestEl) bestEl.textContent = '—';
            const srcEl = this._$('ai-source');
            if (srcEl) srcEl.textContent = '';
            const diagEl = this._$('ai-diagnostics');
            if (diagEl) diagEl.textContent = '—';
            this._paintAdvantage({ side: 'equal', score: 0, depth: 0 });
            this._render();
        }

        /* ---------------- 公共交互 ---------------- */
        setMode(mode, silent) {
            this.game.setGameMode(mode);
            localStorage.setItem('gmk_mode', mode);
            for (const m of ['PvP', 'PvE', 'EvE']) {
                const el = this._$('mode-' + m);
                if (el) el.classList.toggle('active', m === mode);
            }
            this._updatePanelVisibility();
            this.newGame();
            if (!silent) {
                const names = { PvP: '双人对战', PvE: '人机对战', EvE: 'AI 对战', VCF_PRACTICE: 'VCF 练习' };
                this._hint('已切换为：' + (names[mode] || mode));
            }
            // 注意：EvE 的自动对局由 newGame() 内部统一启动（见 newGame 末尾）。
            // 此处不可再调 _startEvE()：EvE 改为异步单步后，重复调用会派生两条
            // 并行的自动落子链（每步落两手），既浪费算力也打乱测试时序。
        }

        /**
         * AI 增强面板可见性：
         *  - #ai-analysis-panel：PvP/PvE/VCF_PRACTICE 显示，EvE 隐藏
         *  - #vcf-panel：始终显示（独立练习入口）
         */
        _updatePanelVisibility() {
            const m = this.game.gameMode;
            // VCF 练习下没有 AI 对手，分析面板（优势条 / 推荐点）没有意义，一并隐藏
            const showAnalysis = m !== 'EvE' && m !== 'VCF_PRACTICE';
            this._show('ai-analysis-panel', showAnalysis);
            this._show('ai-analysis-empty', !showAnalysis);
            this._show('vcf-panel', true);
            // 停在「分析」页却没内容时自动挪走，别让用户对着空页
            if (!showAnalysis && this.tab === 'analysis') {
                this.showTab(m === 'VCF_PRACTICE' ? 'practice' : 'game');
            }
        }

        setDifficulty(d, silent) {
            this.game.setAIDifficulty(d);
            localStorage.setItem('gmk_diff', d);
            for (const x of GMK.Game.DIFFS) {
                const el = this._$('diff-' + x);
                if (el) el.classList.toggle('active', x === d);
            }
            this._show('strength-advanced', d === 'HELL'); // P2-5：仅地狱档显示高级选项
            if (!silent) this._hint('AI 难度：' + (DIFF_LABELS[d] || d));
        }

        setTheme(t, silent) {
            this.theme = t;
            this.renderer.setTheme(t);
            document.body.setAttribute('data-theme', t);
            localStorage.setItem('gmk_theme', t);
            for (const x of ['wood', 'dark', 'light']) {
                const el = this._$('theme-' + x);
                if (el) el.classList.toggle('active', x === t);
            }
        }

        newGame() {
            this.eveAutoPlay = false;
            this._exitReview();        // 复盘状态下开新局：先退回实时棋盘
            this._cancelAIThink();
            this._vcfStopDemo();
            this._pending = null;
            this.renderer.setPending(null);
            this.closeResultModal();   // 开新局要顺手关掉上一局的结算弹窗，否则它会挡住棋盘
            this.vcf = null;
            this.vcfPuzzle = null;
            this.game.reset();
            this.renderer.setWinLine(null);
            this.renderer.clearHint();
            this._currentThreat = null;
            this._clearAIOverlays();
            this._render();
            this._maybeOpeningRec(); // P2-6：新局即给开局推荐（EvE/VCF 内部自动跳过）
            const names = { PvP: '双人对战开始，黑棋先手', PvE: '人机对战开始，你执黑', EvE: 'AI 对战开始' };
            this._hint(names[this.game.gameMode] || '新对局开始');
            if (this.game.gameMode === 'EvE') this._startEvE();
            this._vcfUpdate();
        }

        undo() {
            this._exitReview();
            this._cancelAIThink();
            const g = this.game;
            this._pending = null;
            this.renderer.setPending(null);
            // 人机对战里「悔棋」的直觉是回到自己上次落子前，
            // 所以要连 AI 的应手一起撤；否则撤完立刻又轮到 AI，等于没悔。
            const last = g.moves[g.moves.length - 1];
            const steps = (g.gameMode === 'PvE' && last && last.player === 2 && g.moves.length >= 2) ? 2 : 1;
            if (g.undo(steps)) {
                this._render();
                this._maybeOpeningRec(); // P2-6：悔回开局窗口时恢复推荐
                this._hint(steps === 2 ? '已悔棋（含 AI 应手）' : '已悔一步');
            }
            else this._hint('没有可悔的棋');
        }

        _onPlayerClick(x, y) {
            if (this.reviewing) { this._hint('复盘模式：点「退出」回到对局'); return; }
            if (this.game.gameStatus === 'finished') return;
            if (this.game.gameMode === 'EvE') { this._hint('机机对战模式，玩家无法操作棋盘'); return; }
            if (this.game.gameMode === 'VCF_PRACTICE') { this._vcfPlay(x, y); return; }
            if (this.aiThinking) return;

            // 落子确认（防误触）：第一次点只做预览，再点同一格才真正落子
            if (this.confirmMove) {
                const p = this._pending;
                if (!p || p.x !== x || p.y !== y) {
                    this._pending = { x: x, y: y, player: this.game.currentPlayer };
                    this.renderer.setPending(this._pending);
                    this._hint('再点同一格确认落子');
                    return;
                }
                this._pending = null;
                this.renderer.setPending(null);
            }

            const result = this.game.placePiece(x, y);
            if (!result.success) {
                if (result.code === 'FORBIDDEN_MOVE') { /* forbidden 事件已提示 */ }
                else this._hint('无法在此落子（' + result.code + '）');
                return;
            }

            this._render();
            this._beep(result.nextPlayer === 2 ? 520 : 400, 0.06);

            if (result.gameOver) { this._showResult(result); return; }

            // 轮到 AI？排期到「玩家这一手上屏之后」再开算，绝不在此同步搜索
            if (this._shouldAIMove()) {
                this._scheduleAIThink(0);
            }
        }

        _shouldAIMove() {
            const g = this.game;
            if (g.gameMode === 'PvE') return g.currentPlayer === 2; // 玩家执黑，AI 执白
            if (g.gameMode === 'EvE') return true;
            return false;
        }

        /**
         * 排期一次 AI 思考：先让浏览器把「玩家刚落的那一手」画到屏幕上，再开算。
         *
         * 旧实现是 placePiece → _render → getAIMove 全在同一个任务里同步跑完，
         * 浏览器从头到尾没有机会上屏 —— 玩家点完看到的是「没有任何反应」，
         * 然后 AI 的棋子连同自己的棋子一起突然出现（HELL 档尤其明显，3.5s 全程静止）。
         *
         * 这里用 requestAnimationFrame + setTimeout 两段让出：
         *   rAF  → 本帧绘制前回调，随后浏览器绘制（玩家棋子此时上屏）
         *   timer → 绘制之后的下一轮宏任务，才进入同步搜索
         * aiThinking 在「排期瞬间」就置 true：AI 还没开始算，但棋盘已经禁止再落子，
         * 否则连点两下会插进两手黑棋。
         */
        _scheduleAIThink(delay) {
            if (this._aiPending || this.aiThinking) return;
            this._aiPending = true;
            this.aiThinking = true;
            this._show('ai-thinking', true);

            const wait = typeof delay === 'number' ? delay : 0;
            this._aiRaf = requestAnimationFrame(() => {
                this._aiRaf = 0;
                this._aiTimer = setTimeout(() => {
                    this._aiTimer = 0;
                    this._aiPending = false;
                    const abort = this.game.gameStatus === 'finished' ||
                        !this._shouldAIMove() ||
                        (this.game.gameMode === 'EvE' && !this.eveAutoPlay);
                    if (abort) {
                        this.aiThinking = false;
                        this._show('ai-thinking', false);
                        return;
                    }
                    this._thinkAndMove();
                }, wait);
            });
        }

        /** 撤销排期中的 AI 思考（新局 / 悔棋 / 重置 / 终局都要调，否则会往新盘上补子） */
        _cancelAIThink() {
            this._aiPending = false;
            if (this._aiRaf) { cancelAnimationFrame(this._aiRaf); this._aiRaf = 0; }
            if (this._aiTimer) { clearTimeout(this._aiTimer); this._aiTimer = 0; }
            if (this.aiThinking) {
                this.aiThinking = false;
                this._show('ai-thinking', false);
            }
        }

        _thinkAndMove() {
            this.aiThinking = true;
            this._show('ai-thinking', true);
            const ai = this.game.getAIMove();
            this._show('ai-thinking', false);
            this.aiThinking = false;

            if (!ai) return;
            const r = this.game.placePiece(ai.x, ai.y);
            this._render();
            this.renderer.setHint({ x: ai.x, y: ai.y });
            setTimeout(() => this.renderer.clearHint(), 800);
            if (r && r.gameOver) {
                this._showResult(r);
            } else if (this.game.gameMode === 'EvE' && this.eveAutoPlay) {
                // EvE 异步单步：走同一套排期逻辑，绝不在此同步递归。
                // 旧实现是同步递归，EvE 下 _shouldAIMove() 恒 true，会把整局
                // （最多 225 手 × 难度思考时长）一口气打完并堵死 UI 线程，
                // 导致 setMode('EvE') 长时间不返回、后续面板/时序断言全部超时。
                this._scheduleAIThink(60);
            }
            // PvE 不递归：白应招后 currentPlayer 变 1，_shouldAIMove() 为 false。
        }

        _startEvE() {
            this.eveAutoPlay = true;
            if (this.game.gameStatus === 'playing' || this.game.gameStatus === 'ready') {
                this._hint('机机对战中，稍候…');
                // 留 80ms 让「机机对战中」提示先上屏，再开始第一步同步搜索
                this._scheduleAIThink(80);
            }
        }

        _render() {
            const g = this.game;
            // 复盘期间棋盘归 Replayer 驱动，实时渲染会打断回放；只刷新侧栏
            if (this.reviewing) { this._paintMoveList(); this._paintTimer(); return; }
            const last = g.getLastMove();
            // 威胁点：仅威胁开关开启且处于对局中时绘制
            const threat = (this.showThreat && this._currentThreat &&
                g.gameStatus !== 'finished') ? this._currentThreat : null;
            this.renderer.render(g.getBoardState(), {
                lastMove: last ? { x: last.x, y: last.y, player: last.player } : null,
                threat: threat
            });
            // 状态面板
            const info = g.getGameInfo();
            const cp = this._$('current-player');
            if (cp) cp.textContent = g.gameStatus === 'finished'
                ? (g.winner === 0 ? '平局' : (g.winner === 1 ? '黑方胜' : '白方胜'))
                : (g.currentPlayer === 1 ? '黑方' : '白方') + '行棋';
            const mv = this._$('move-count');
            if (mv) mv.textContent = '第 ' + info.moveCount + ' 手';
            this._paintMoveList();
            this._paintTimer();
        }

        _showResult(result) {
            const g = this.game;
            this._cancelAIThink();
            this._recordResult(result.winner);
            this._beep(result.winner === 1 ? 880 : 300, 0.18);
            const title = this._$('result-title'), detail = this._$('result-detail'), modal = this._$('game-result-modal');
            if (!title || !modal) return;
            if (result.winner === 0) { title.textContent = '平局'; detail.textContent = '棋盘已满，不分胜负'; }
            else {
                const w = result.winner === 1 ? '黑方' : '白方';
                title.textContent = w + '获胜';
                const ai = g.lastAIInfo;
                detail.textContent = '共 ' + g.moves.length + ' 手' + (ai ? ' · 引擎 ' + (ai.depth || 0) + ' 层 / ' + (ai.nodes || 0) + ' 节点' : '');
            }
            modal.classList.add('active');
            this.game.setWinLine && 0; // winLine 由渲染器 drawWinLine 处理
            const wl = result.winLine;
            if (wl) this.renderer.setWinLine(wl);
            this._render();
        }

        _hint(msg) {
            const el = this._$('hint-message');
            if (el) { el.textContent = msg; el.classList.add('show'); }
        }

        /* ---------------- 快捷键 ---------------- */
        bindShortcuts() {
            document.addEventListener('keydown', e => {
                // 输入框里不抢按键（棋谱粘贴、高级强度输入）
                const tag = e.target && e.target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

                const k = e.key;

                if (k === 'Escape') {
                    this._show('game-result-modal', false);
                    this._exitReview();
                    this.cursor = null;
                    this.renderer.setCursor(null);
                    this._pending = null;
                    this.renderer.setPending(null);
                    return;
                }

                // 方向键移动光标（键盘用户 / 无障碍）
                if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
                    if (!this.cursor) this.cursor = { x: 7, y: 7 };
                    if (k === 'ArrowLeft') this.cursor.x = Math.max(0, this.cursor.x - 1);
                    if (k === 'ArrowRight') this.cursor.x = Math.min(14, this.cursor.x + 1);
                    if (k === 'ArrowUp') this.cursor.y = Math.max(0, this.cursor.y - 1);
                    if (k === 'ArrowDown') this.cursor.y = Math.min(14, this.cursor.y + 1);
                    e.preventDefault();
                    this.renderer.setCursor(this.cursor);
                    const ind = this._$('cursor-indicator');
                    if (ind) ind.textContent = cxy(this.cursor.x, this.cursor.y);
                    return;
                }

                // 回车 / 空格：在光标处落子
                if (k === 'Enter' || k === ' ') {
                    e.preventDefault();
                    const c = this.cursor || { x: 7, y: 7 };
                    this.cursor = c;
                    this.renderer.setCursor(c);
                    this._onPlayerClick(c.x, c.y);
                    return;
                }

                if (k === 'u' || k === 'U') this.undo();
                if (k === 'n' || k === 'N') this.newGame();
                if (k === 'r' || k === 'R') this.resign();
                if (k === 'h' || k === 'H') {
                    if (this.game.gameMode === 'VCF_PRACTICE') this._vcfHint();
                    else this._runDeepEval();
                }
            });
        }

        closeResultModal() {
            const m = this._$('game-result-modal');
            if (m) m.classList.remove('active');
        }

        start() {
            this.bindShortcuts();
            this.closeResultModal();
            this._render();
        }
    }

    GMK.App = App;
    if (typeof module !== 'undefined' && module.exports) module.exports = App;
})();
