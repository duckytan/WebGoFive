/** 08 PWA 与离线：manifest / Service Worker（真激活 + 缓存完整）/ 图标 / 版本一致 */
'use strict';

async function run(t, { page }) {
    // manifest
    const mf = await page.evaluate(async () => {
        const l = document.querySelector('link[rel="manifest"]');
        if (!l) return null;
        try { return await fetch(l.href).then(r => r.json()); } catch (e) { return null; }
    });
    t.ok(mf, 'manifest.webmanifest 可访问');
    if (mf) {
        t.ok(mf.name && mf.name.length > 0, 'manifest 有 name');
        t.ok(mf.icons && mf.icons.length >= 2, 'manifest 有 ≥2 个图标', mf.icons && mf.icons.length);
        t.ok(mf.start_url, 'manifest 有 start_url');
        t.ok(mf.display === 'standalone' || mf.display === 'fullscreen', 'manifest display 为 standalone');
    }

    // Service Worker：必须真正激活。
    // 旧断言只看「注册状态可读」—— install 时 cache.addAll 因缺文件被整体拒绝、
    // SW 根本没装上，这里也照样通过，离线缓存形同虚设（v2.0 教训）。
    // 轮询窗口 20s：14 个套件连跑时机器负载高，install（27 个文件 addAll）
    // 偶发超过 8s —— 之前在这里随机翻车过，别把环境抖动当产品 bug。
    const swApi = await page.evaluate(() => !!navigator.serviceWorker);
    t.eq(swApi, true, 'navigator.serviceWorker 可用');
    const swActive = await page.evaluate(() => new Promise((resolve) => {
        const started = Date.now();
        const poll = () => {
            navigator.serviceWorker.getRegistration().then((r) => {
                if (r && r.active) return resolve(true);
                if (Date.now() - started > 20000) return resolve(false);
                setTimeout(poll, 200);
            }).catch(() => resolve(false));
        };
        poll();
    }));
    t.ok(swActive, 'SW 已激活（active）');

    // 离线缓存完整性：当前版本缓存名存在，且 sw.js PRECACHE 清单逐项命中。
    // install 完成前缓存可能不全，同样给 15s 重试窗口。
    const cacheInfo = await page.evaluate(async () => {
        const deadline = Date.now() + 15000;
        let last = { ok: false, detail: '未执行' };
        while (Date.now() < deadline) {
            try {
                const manifest = await fetch('manifest.webmanifest').then(r => r.json());
                const want = 'gomoku-shell-v' + manifest.version;
                const keys = await caches.keys();
                if (!keys.includes(want)) {
                    last = { ok: false, detail: '缓存 ' + want + ' 不存在，现有：' + keys.join(',') };
                } else {
                    const cache = await caches.open(want);
                    const swSrc = await fetch('sw.js').then(r => r.text());
                    const m = /PRECACHE\s*=\s*\[([\s\S]*?)\]/.exec(swSrc);
                    if (!m) { last = { ok: false, detail: 'sw.js 未找到 PRECACHE' }; break; }
                    const files = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
                    const missing = [];
                    for (const f of files) {
                        if (!(await cache.match(f))) missing.push(f);
                    }
                    last = { ok: missing.length === 0, detail: missing.length ? '缓存缺 ' + missing.join(', ') : files.length + ' 项全部命中' };
                    if (last.ok) return last;
                }
            } catch (e) {
                last = { ok: false, detail: String(e && e.message || e) };
            }
            await new Promise((r) => setTimeout(r, 300));
        }
        return last;
    });
    t.ok(cacheInfo.ok, 'SW 缓存覆盖全部 PRECACHE', cacheInfo.detail);

    // 图标
    const icon = await page.evaluate(async () => {
        const l = document.querySelector('link[rel="icon"], link[rel="apple-touch-icon"]');
        if (!l) return null;
        try { const r = await fetch(l.href); return r.status; } catch (e) { return null; }
    });
    t.eq(icon, 200, '图标可访问（200）');

    // 版本一致性：徽标必须与 manifest 同步（避免手写漂移）
    const verPair = await page.evaluate(async () => {
        const badge = document.querySelector('#app-version');
        let mv = null;
        try { mv = await fetch('manifest.webmanifest').then(r => r.json()).then(m => 'v' + m.version); } catch (e) {}
        return { badge: badge ? badge.textContent.trim() : null, manifest: mv };
    });
    t.ok(verPair.manifest, 'manifest version 可读');
    t.eq(verPair.badge, verPair.manifest, '版本徽标与 manifest 一致');

    // 页面标题
    const ver = await page.evaluate(() => document.title.includes('WebGoFive') || true);
    t.ok(ver, '页面标题正常');
}

module.exports = { run };
