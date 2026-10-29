/**
 * Service Worker —— 离线可用
 *
 * 策略：
 *   · 导航请求（HTML）：network-first。保证联网时总能拿到最新版；
 *     断网时回退到缓存的 index.html。
 *   · 静态资源（js/css/png/manifest）：stale-while-revalidate。
 *     先用缓存立即渲染，后台悄悄更新，下次生效。
 *
 * 缓存名里带版本号，activate 时清掉旧版本，避免升级后新旧文件混用。
 */
'use strict';

const VERSION = '2.4.0';
const CACHE_NAME = 'gomoku-shell-v' + VERSION;

// 必须与 index.html 实际加载的资源一致：
// cache.addAll 对任何一个 404 都会整体拒绝，SW 就装不上、离线全失效。
// 此清单由 tests/accept.js 的「sw.js PRECACHE 清单文件都存在」闸门盯着。
const PRECACHE = [
    './',
    './index.html',
    './manifest.webmanifest',
    './css/style.css',
    './css/animations.css',
    './css/themes.css',
    './js/engine/constants.js',
    './js/engine/board.js',
    './js/engine/evaluator.js',
    './js/engine/search.js',
    './js/engine/kill.js',
    './js/engine/forbidden.js',
    './js/engine/gomoku-ai.js',
    './js/core/game.js',
    './js/renderer/board.js',
    './js/app/save-load.js',
    './js/app/replay.js',
    './js/app/vcf.js',
    './js/app/analysis.js',
    './js/app/tunable-ai.js',
    './js/ui/app.js',
    './assets/icon-192.png',
    './assets/icon-512.png',
    './assets/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(PRECACHE))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    // 导航：网络优先
    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req)
                .then((res) => {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((c) => c.put('./index.html', copy)).catch(() => {});
                    return res;
                })
                .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
        );
        return;
    }

    // 静态资源：缓存优先 + 后台更新
    event.respondWith(
        caches.match(req).then((cached) => {
            const network = fetch(req).then((res) => {
                if (res && res.status === 200 && res.type === 'basic') {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
                }
                return res;
            }).catch(() => cached);

            return cached || network;
        })
    );
});

// 允许页面主动触发更新
self.addEventListener('message', (event) => {
    if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
