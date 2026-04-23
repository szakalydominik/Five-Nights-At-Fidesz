/* ViewportManager.js
 * Runtime viewport measurement + adaptive scaling for FNAF.
 *
 * Responsibilities:
 *  1. Mérjük az aktuális viewport-ot (innerWidth / innerHeight / visualViewport)
 *     és frissítsük a CSS custom property-ket minden rögtön elérhető helyzetben:
 *       --vw-px, --vh-px   – valós pixelek (iOS Safari 100vh bug workaround)
 *       --vmin-px, --vmax-px
 *       --safe-top, --safe-right, --safe-bottom, --safe-left – env() valós pixelben
 *       --ui-scale         – normalizált skálázó faktor (0.35 .. 1.4)
 *       --font-scale       – szöveges méretekhez használt súlyozott skála
 *       --cam-strip        – a kamera gomb jobb-oldali sávjának szélessége pixelben
 *       --game-scale       – fit-to-viewport scale egy 1920x1080-as "design canvas"-hez
 *  2. A <body>-ra rakunk osztályokat, hogy a CSS egyetlen szelektorral tudjon
 *     eszköz-kategóriára hangolni:
 *       device-xs / sm / md / lg / xl     (szélesség alapján)
 *       orient-portrait / orient-landscape
 *       aspect-tall / square / wide / ultrawide
 *       input-touch / input-mouse
 *       dpr-1x / dpr-2x / dpr-3x
 *  3. Minden változásra újramérünk: resize, orientationchange, visualViewport scroll / resize,
 *     valamint egy ResizeObserver a html root-on.
 *
 * A modult az oldal legelején töltjük be, hogy az első renderkor már helyes állapot legyen.
 */
(function () {
    'use strict';

    var root = document.documentElement;
    var body = document.body;

    var DESIGN_W = 1920;
    var DESIGN_H = 1080;

    function clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    function readSafeAreaInset(side) {
        // env() eredményét JS-ből nem tudjuk olvasni, így trükközünk egy
        // láthatatlan div-vel, amire padding: env(safe-area-inset-*)-t teszünk,
        // és lemérjük a computed pixelt.
        var probeId = '__fnaf_safe_area_probe__';
        var probe = document.getElementById(probeId);
        if (!probe) {
            probe = document.createElement('div');
            probe.id = probeId;
            probe.style.cssText = [
                'position:fixed',
                'top:0',
                'left:0',
                'width:0',
                'height:0',
                'pointer-events:none',
                'visibility:hidden',
                'padding-top:env(safe-area-inset-top,0px)',
                'padding-right:env(safe-area-inset-right,0px)',
                'padding-bottom:env(safe-area-inset-bottom,0px)',
                'padding-left:env(safe-area-inset-left,0px)'
            ].join(';');
            (document.body || document.documentElement).appendChild(probe);
        }
        var cs = getComputedStyle(probe);
        var value = cs['padding-' + side];
        var n = parseFloat(value);
        return isFinite(n) ? n : 0;
    }

    function classifyDevice(w, h, isTouch) {
        // MOBIL KÉNYSZER: ha touch input ÉS landscape ÉS a magasság < 900 px,
        // akkor ez egy telefon/tablet landscape-ben, FÜGGETLENÜL attól, hogy a
        // logikai szélesség esetleg >1440-nek mondja magát (pl. magas DPR +
        // rosszul skálázott WebView). Ilyenkor kényszerítsük device-md-re, hogy
        // a mobil CSS override-ok (nagy óra, nagy O2, notch-biztos pozíciók)
        // biztosan életbe lépjenek.
        if (isTouch && w > h && h < 900) {
            if (h < 500) return 'device-sm';
            return 'device-md';
        }
        // Tailwind-szerű töréspontok, a legkisebb phone (≤480) külön.
        if (w < 480) return 'device-xs';
        if (w < 768) return 'device-sm';
        if (w < 1024) return 'device-md';
        if (w < 1440) return 'device-lg';
        return 'device-xl';
    }

    function classifyAspect(w, h) {
        var r = w / h;
        if (r < 0.9) return 'aspect-tall';
        if (r < 1.1) return 'aspect-square';
        if (r < 2.1) return 'aspect-wide';
        return 'aspect-ultrawide';
    }

    function classifyDpr() {
        var dpr = window.devicePixelRatio || 1;
        if (dpr >= 2.75) return 'dpr-3x';
        if (dpr >= 1.75) return 'dpr-2x';
        return 'dpr-1x';
    }

    function classifyInput() {
        try {
            if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
                return 'input-touch';
            }
        } catch (e) { /* ignore */ }
        if ('ontouchstart' in window) return 'input-touch';
        return 'input-mouse';
    }

    function setClassGroup(target, prefix, value) {
        if (!target) return;
        var toRemove = [];
        for (var i = 0; i < target.classList.length; i++) {
            var cls = target.classList[i];
            if (cls.indexOf(prefix) === 0) toRemove.push(cls);
        }
        toRemove.forEach(function (c) { target.classList.remove(c); });
        target.classList.add(value);
    }

    var lastState = null;
    var rafHandle = 0;

    function measure() {
        // visualViewport pontosabb iOS-en (eltünő címsor figyelembevétele).
        var vv = window.visualViewport;
        var w = Math.round((vv && vv.width) ? vv.width : window.innerWidth);
        var h = Math.round((vv && vv.height) ? vv.height : window.innerHeight);
        if (!w || !h) return;

        var safeTop = readSafeAreaInset('top');
        var safeRight = readSafeAreaInset('right');
        var safeBottom = readSafeAreaInset('bottom');
        var safeLeft = readSafeAreaInset('left');

        var safeW = Math.max(1, w - safeLeft - safeRight);
        var safeH = Math.max(1, h - safeTop - safeBottom);

        var landscape = w >= h;

        // ui-scale: egy 1024x600-as alap (kis tablet landscape) az 1.0 referencia.
        // Ezalatt lefelé csökken (telefon), felette felfele nő (desktop) – korlátosan.
        var byWidth = safeW / 1024;
        var byHeight = safeH / 600;
        var uiScale = clamp(Math.min(byWidth, byHeight), 0.35, 1.4);

        // Font scale: kevésbé agresszív kicsit, hogy telefonon se legyen olvashatatlan.
        var fontScale = clamp(0.4 + 0.6 * uiScale, 0.6, 1.3);

        // Fit-to-viewport scale egy 1920x1080-as "design canvas"-hez.
        // Akkor használjuk, amikor egy adott elemet arányosan akarunk méretezni
        // (pl. kamera panel grid).
        var gameScale = Math.min(safeW / DESIGN_W, safeH / DESIGN_H);

        // Kamera-gomb sáv szélessége jobb oldalon.
        // Telefonon ~ 60–80 px, tableten ~ 84 px, desktopon lehet keskenyebb is (arány),
        // de alsó limit 54 px a tap-méret miatt.
        var camStrip = Math.round(clamp(safeW * 0.07, 54, 96));

        // Tutorial / főmenü safe content max-méret.
        var contentMaxW = Math.round(Math.min(safeW * 0.9, 1080));
        var contentMaxH = Math.round(safeH * 0.92);

        var state = {
            w: w, h: h,
            safeW: safeW, safeH: safeH,
            safeTop: safeTop, safeRight: safeRight,
            safeBottom: safeBottom, safeLeft: safeLeft,
            landscape: landscape,
            uiScale: uiScale,
            fontScale: fontScale,
            gameScale: gameScale,
            camStrip: camStrip,
            contentMaxW: contentMaxW,
            contentMaxH: contentMaxH
        };

        // Rendezett számokat írunk, hogy ne triggereljünk felesleges reflow-t csak mert
        // 0.00001 különbség van.
        var key = [w, h, safeTop, safeRight, safeBottom, safeLeft].join('|');
        if (lastState && lastState.__key === key) return;
        state.__key = key;
        lastState = state;

        root.style.setProperty('--vw-px', w + 'px');
        root.style.setProperty('--vh-px', h + 'px');
        root.style.setProperty('--vmin-px', Math.min(w, h) + 'px');
        root.style.setProperty('--vmax-px', Math.max(w, h) + 'px');
        root.style.setProperty('--safe-top', safeTop + 'px');
        root.style.setProperty('--safe-right', safeRight + 'px');
        root.style.setProperty('--safe-bottom', safeBottom + 'px');
        root.style.setProperty('--safe-left', safeLeft + 'px');
        root.style.setProperty('--safe-w-px', safeW + 'px');
        root.style.setProperty('--safe-h-px', safeH + 'px');
        root.style.setProperty('--ui-scale', uiScale.toFixed(4));
        root.style.setProperty('--font-scale', fontScale.toFixed(4));
        root.style.setProperty('--game-scale', gameScale.toFixed(4));
        root.style.setProperty('--cam-strip', camStrip + 'px');
        root.style.setProperty('--content-max-w', contentMaxW + 'px');
        root.style.setProperty('--content-max-h', contentMaxH + 'px');

        if (body) {
            var inputClass = classifyInput();
            var isTouch = inputClass === 'input-touch';
            setClassGroup(body, 'device-', classifyDevice(safeW, safeH, isTouch));
            setClassGroup(body, 'orient-', landscape ? 'orient-landscape' : 'orient-portrait');
            setClassGroup(body, 'aspect-', classifyAspect(safeW, safeH));
            setClassGroup(body, 'input-', inputClass);
            setClassGroup(body, 'dpr-', classifyDpr());
        }

        // Külső kódok (pl. CameraSystem) számára is elérhetővé tesszük.
        window.__fnafViewport = state;
        try {
            window.dispatchEvent(new CustomEvent('fnaf:viewport', { detail: state }));
        } catch (e) { /* IE fallback nem kell */ }
    }

    function scheduleMeasure() {
        if (rafHandle) return;
        rafHandle = requestAnimationFrame(function () {
            rafHandle = 0;
            measure();
        });
    }

    // --- Első mérés: amilyen hamar csak lehet. ---
    function firstMeasure() {
        // Ha még nincs body, várunk DOMContentLoaded-ig, de utána azonnal újramérünk.
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', firstMeasure, { once: true });
            return;
        }
        body = document.body;
        measure();
        // Még egy mérés a fontok / safe-area beállására.
        requestAnimationFrame(function () {
            requestAnimationFrame(measure);
        });
    }
    firstMeasure();

    // --- Változás-eseményekre figyelés ---
    window.addEventListener('resize', scheduleMeasure, { passive: true });
    window.addEventListener('orientationchange', scheduleMeasure, { passive: true });
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', scheduleMeasure, { passive: true });
        window.visualViewport.addEventListener('scroll', scheduleMeasure, { passive: true });
    }
    document.addEventListener('fullscreenchange', scheduleMeasure);
    document.addEventListener('webkitfullscreenchange', scheduleMeasure);
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) scheduleMeasure();
    });

    // ResizeObserver a html elemen – biztosítja hogy bárhol bekapcsolt zoom,
    // kinyílt vitrtuális billentyűzet, beugró system UI mind triggereli a mérést.
    try {
        if (typeof ResizeObserver === 'function') {
            var ro = new ResizeObserver(scheduleMeasure);
            ro.observe(document.documentElement);
            if (document.body) ro.observe(document.body);
        }
    } catch (e) { /* ignore */ }

    // Debug hook.
    window.__fnafViewportRemeasure = measure;
})();
