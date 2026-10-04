// ==UserScript==
// @name         CodeCV 简历一键无水印导出（多页修复版）
// @name:en      CodeCV Resume One-Click PDF Export (multi-page fix)
// @namespace    https://github.com/XXWen0201/codecv-export
// @version      4.1.0
// @description  一键把 CodeCV 简历导出成 A4 高清 PDF，修复原版「多页简历只导出最后一页」的问题；打印后自动还原页面，水印只隐藏不删除。
// @author       Campus（原版）· 多页修复 by XXWen0201
// @match        *://www.codecvcv.com/cv/*
// @match        *://codecvcv.com/cv/*
// @grant        none
// @license      MIT
// @run-at       document-idle
// @homepageURL  https://github.com/XXWen0201/codecv-export
// @supportURL   https://github.com/XXWen0201/codecv-export/issues
// @icon         https://cdn.jsdelivr.net/gh/XXWen0201/codecv-export@main/icons/icon128.png
// @downloadURL  https://cdn.jsdelivr.net/gh/XXWen0201/codecv-export@main/codecv-export.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/XXWen0201/codecv-export@main/codecv-export.user.js
// ==/UserScript==

/* ============================================================================
 * 【v4 设计原则：能不动就不动】
 * ----------------------------------------------------------------------------
 * 前两版翻车原因（都是"改动超出必要范围"）：
 *   v2 把 CodeCV 依赖的 absolute 定位容器改成 static → 内容重复、错位、露黑底。
 *   v3 加了「隐藏所有 position:fixed/sticky 元素」的规则去清浮层，
 *      结果把简历正文容器一起隐藏了 → 纸张还在、内容全空。
 *
 * v4 只做一件事：把每一页的 top 从「全部 0」改成「第 n 页 = (n-1) × 297mm」。
 * 其余所有规则**逐字沿用原脚本**，一个字都不多加。
 * 浮层改成按文字特征精准匹配（且限定在小尺寸徽标上），绝不再批量隐藏元素。
 *
 * 【根因】原脚本的这一段把每一页都压在同一个点 (0,0) 上，
 *         后一页盖住前一页，所以两页简历只剩最后一页：
 *             .re-render, .jufe-wrapper-page, .jufe-wrapper-page-item {
 *                 position: absolute !important;
 *                 top: 0 !important; left: 0 !important;
 *             }
 *         只需让每页的 top 依次为 0 / 297mm / 594mm……即恢复成一页一张纸。
 *
 *   已用无头 Chrome 实测：原版 CSS 输出 1 页；本方案输出页数与实际一致。
 *
 * v4.1 只修「潜伏的雷」，不动任何已跑通的逻辑：
 *   a) 水印原来用 el.remove() 直接删 DOM —— 不可逆。一旦误命中包裹简历的容器，
 *      内容会被永久删掉（和 v3 空白 bug 同源）。改为「打印时隐藏 + 打印后恢复」，
 *      并且明确跳过「包裹着页元素的祖先」，宁可漏隐藏也不动简历。
 *   b) 还原 top 时丢了 !important 优先级 —— 改为连优先级一起存、一起还原。
 *   c) 新增「某页内容超出一页 A4」告警 —— 这是原脚本就有的静默丢失路径：
 *      打印样式给每页写死 height:297mm，超出部分会从 PDF 里彻底消失且毫无提示。
 *      修不掉（放开 height 只会盖到下一页），所以至少明确报警。
 *   另：__codecvExport 上多挂了 checkOverflow / layout / restore，方便手动排错。
 *
 * 【合规边界】
 *   只处理你自己本机已渲染出来的简历内容。不构造请求、不绕过付费墙、不批量抓取。
 *   站点若在服务端往导出文件里烧水印，本脚本无能为力。
 * ========================================================================== */

(function () {
    'use strict';

    /* ========================================================================
     * CONFIG —— 唯一适配层：站点改版只改这里
     * ====================================================================== */
    const CONFIG = {
        pageSelector: '.jufe-wrapper-page-item',
        pageFallbacks: [
            '.jufe-wrapper-page > *',
            '[class*="page-item"]',
            '.re-render > *',
            '[class*="wrapper-page"]'
        ],
        singlePageSelector: '.markdown-transform-html',

        pageHeightMM: 297,       // 一页的高度（A4）
        hideWatermark: true,     // 打印时隐藏类名含 watermark 的元素（原脚本是直接删 DOM，这里改为可恢复的隐藏）
        hideBadges: true,        // 打印前隐藏「正在校验」这类小徽标（精准匹配，不批量隐藏）
        debug: false
    };
    /* ====================================================================== */

    const BTN_ID = 'codecv-export-btn';
    const DIAG_ID = 'codecv-diag-btn';
    const TOAST_ID = 'codecv-toast';
    const PAGE_MARK = 'codecv-print-page';
    const BADGE_CLASS = 'codecv-hide-badge';
    const TOP_FLAG = 'data-codecv-top';
    const TOP_PRIO_FLAG = 'data-codecv-top-prio';

    // 「校验 / 防伪」类小徽标的文字特征
    const BADGE_RE = /正在校验|校验中|校验第|防伪|仅供预览|禁止转载|下载后|请勿外传/;

    /* ---------------------------------------------------------------------
     * 1. 样式
     *    —— 打印部分严格沿用原脚本，只在标注「★」的两处做了必要调整
     * ------------------------------------------------------------------- */
    const CSS = `
        /* ===== 屏幕态：按钮 ===== */
        #${BTN_ID} {
            position: fixed; top: 50%; left: 0; transform: translateY(-50%);
            z-index: 2147483647;
            width: 35px; padding: 15px 5px;
            background: #333; color: #fff; border: none; outline: none;
            border-radius: 0 5px 5px 0; cursor: pointer;
            writing-mode: vertical-lr; font-size: 12px; letter-spacing: 1px;
            font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif;
            opacity: .5; transition: .3s;
        }
        #${BTN_ID}:hover { opacity: 1; background: #ff7449; }

        #${DIAG_ID} {
            position: fixed; top: calc(50% + 80px); left: 0;
            z-index: 2147483647;
            width: 35px; padding: 8px 5px;
            background: #777; color: #fff; border: none; outline: none;
            border-radius: 0 5px 5px 0; cursor: pointer;
            writing-mode: vertical-lr; font-size: 11px; letter-spacing: 1px;
            font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif;
            opacity: .35; transition: .3s;
        }
        #${DIAG_ID}:hover { opacity: 1; background: #ff7449; }

        #${TOAST_ID} {
            position: fixed; left: 50%; bottom: 40px; transform: translateX(-50%);
            z-index: 2147483647;
            max-width: 78vw; padding: 10px 18px;
            background: rgba(30,30,30,.92); color: #fff;
            border-radius: 8px; font-size: 13px; line-height: 1.6;
            font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif;
            opacity: 0; pointer-events: none; transition: opacity .25s;
            white-space: pre-wrap; text-align: center;
        }
        #${TOAST_ID}.show { opacity: 1; }
        #${TOAST_ID}.warn { background: rgba(200,60,40,.94); }

        /* ===== 打印态 ===== */
        @media print {

            /* --- 原脚本的隐藏列表，仅追加我们自己的三个元素 --- */
            #${BTN_ID}, #${DIAG_ID}, #${TOAST_ID},
            .tamper-print-btn, .operator, #header-nav, .markdown-edit, .shadow, .history,
            .crisp-client, #ark-float-btn, .el-scrollbar__bar, .toggle-edit-mode,
            .preview-cv::before, .preview-cv::after,
            .${BADGE_CLASS} {
                display: none !important;
            }

            /* --- 原脚本的容器重置，逐字不动 --- */
            html, body, #__nuxt, #main, #editor, .flex, .preview-cv,
            .el-scrollbar__wrap, .el-scrollbar__view {
                margin: 0 !important; padding: 0 !important;
                height: auto !important; width: 100% !important;
                display: block !important;
                position: static !important;
                overflow: visible !important;
                background: white !important;
            }

            /* --- 两层容器：定位方式原样保留（absolute + top:0）---
                   ★调整：放开 height 与 overflow，否则第 2 页之后会被裁掉；
                          背景置透明，避免页与页之间露出深色底。 --- */
            .re-render, .jufe-wrapper-page {
                position: absolute !important;
                top: 0 !important; left: 0 !important;
                width: 100% !important;
                height: auto !important;
                max-height: none !important;
                overflow: visible !important;
                margin: 0 !important; padding: 0 !important;
                border: none !important;
                box-shadow: none !important;
                transform: none !important;
                background: transparent !important;
            }

            /* --- ★核心修复★ 每一页仍然 absolute（与站点一致），
                   只是 top 不再写死 0 —— 由 JS 写成 0 / 297mm / 594mm … --- */
            .jufe-wrapper-page-item, .${PAGE_MARK} {
                position: absolute !important;
                left: 0 !important;
                width: 100% !important;
                height: 297mm !important;
                margin: 0 !important; padding: 0 !important;
                border: none !important;
                box-shadow: none !important;
                transform: none !important;
                background: #fff !important;
            }

            /* JS 万一没跑到时的兜底：按序号排开（最多 10 页） */
            .jufe-wrapper-page-item:nth-of-type(1), .${PAGE_MARK}:nth-of-type(1) { top: 0mm !important; }
            .jufe-wrapper-page-item:nth-of-type(2), .${PAGE_MARK}:nth-of-type(2) { top: 297mm !important; }
            .jufe-wrapper-page-item:nth-of-type(3), .${PAGE_MARK}:nth-of-type(3) { top: 594mm !important; }
            .jufe-wrapper-page-item:nth-of-type(4), .${PAGE_MARK}:nth-of-type(4) { top: 891mm !important; }
            .jufe-wrapper-page-item:nth-of-type(5), .${PAGE_MARK}:nth-of-type(5) { top: 1188mm !important; }
            .jufe-wrapper-page-item:nth-of-type(6), .${PAGE_MARK}:nth-of-type(6) { top: 1485mm !important; }
            .jufe-wrapper-page-item:nth-of-type(7), .${PAGE_MARK}:nth-of-type(7) { top: 1782mm !important; }
            .jufe-wrapper-page-item:nth-of-type(8), .${PAGE_MARK}:nth-of-type(8) { top: 2079mm !important; }
            .jufe-wrapper-page-item:nth-of-type(9), .${PAGE_MARK}:nth-of-type(9) { top: 2376mm !important; }
            .jufe-wrapper-page-item:nth-of-type(10), .${PAGE_MARK}:nth-of-type(10) { top: 2673mm !important; }

            /* --- 原脚本的正文内边距 --- */
            .markdown-transform-html { padding: 8mm 12mm !important; }

            /* --- 原脚本的页面设置 --- */
            @page { size: A4 portrait; margin: 0; }
            * {
                -webkit-print-color-adjust: exact !important;
                print-color-adjust: exact !important;
            }
        }
    `;

    const styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    (document.head || document.documentElement).appendChild(styleEl);

    /* ---------------------------------------------------------------------
     * 2. 页元素探测
     * ------------------------------------------------------------------- */
    function isPageLike(el) {
        return el && el.nodeType === 1 && el.getBoundingClientRect().height > 400;
    }

    function detectPages() {
        let pages = Array.from(document.querySelectorAll(CONFIG.pageSelector));
        if (pages.length) return pages;

        for (const sel of CONFIG.pageFallbacks) {
            pages = Array.from(document.querySelectorAll(sel)).filter(isPageLike);
            if (pages.length) return pages;
        }

        const md = document.querySelector(CONFIG.singlePageSelector);
        if (md) return [md];

        return [];
    }

    /* ---------------------------------------------------------------------
     * 3. 打印布局：只做「逐页错开 top」这一件事
     * ------------------------------------------------------------------- */

    let lastOverflow = [];           // 上一次检查中「内容超出一页」的页码

    /**
     * 检查有没有哪一页内容超过了一页 A4。
     *
     * 背景：打印样式给每页写死 `height: 297mm`（沿用原脚本），而站点在页元素上
     * 有 `overflow: hidden` —— 一旦某页内容超过 297mm，**超出部分会被静默裁掉，
     * 页数还是对的，肉眼很难发现**。这是原脚本就存在的设计，改不掉（改成
     * overflow: visible 会让它盖到下一页上，更糟），所以至少给个明确告警。
     *
     * 必须在「套用打印样式之前」量，此时还是屏幕态：clientHeight 是一页高度，
     * scrollHeight 是内容真实高度。clientHeight 太小（元素被隐藏）时跳过，避免误报。
     */
    function checkOverflow(pages) {
        const out = [];
        pages.forEach((el, i) => {
            if (el.clientHeight > 100 && el.scrollHeight > el.clientHeight + 2) {
                out.push(i + 1);
            }
        });
        return out;
    }

    function applyPrintLayout() {
        const pages = detectPages();
        if (!pages.length) return null;

        // 先量，再改样式 —— 顺序反了就量不准（那时打印样式已生效）
        lastOverflow = checkOverflow(pages);

        pages.forEach((el, i) => {
            if (!el.hasAttribute(TOP_FLAG)) {
                // 连同「优先级」一起存：站点若把 top 写成 !important，还原时不能丢
                el.setAttribute(TOP_FLAG, el.style.getPropertyValue('top') || '');
                el.setAttribute(TOP_PRIO_FLAG, el.style.getPropertyPriority('top') || '');
            }
            el.classList.add(PAGE_MARK);
            el.style.setProperty('top', (i * CONFIG.pageHeightMM) + 'mm', 'important');
        });

        if (CONFIG.hideBadges) hideBadges(pages);
        hideWatermarks(pages);

        return pages;
    }

    function restorePrintLayout() {
        document.querySelectorAll('[' + TOP_FLAG + ']').forEach(el => {
            const original = el.getAttribute(TOP_FLAG);
            const prio = el.getAttribute(TOP_PRIO_FLAG) || '';
            el.style.removeProperty('top');
            if (original) el.style.setProperty('top', original, prio);
            el.removeAttribute(TOP_FLAG);
            el.removeAttribute(TOP_PRIO_FLAG);
            el.classList.remove(PAGE_MARK);
        });
        document.querySelectorAll('.' + BADGE_CLASS).forEach(el => {
            el.classList.remove(BADGE_CLASS);
        });
    }

    /**
     * 隐藏「正在校验第 N 页」这类小徽标。
     * 严格限定：文字匹配 + 尺寸很小 + 不在简历页的祖先链上。
     * 绝不像 v3 那样按 position 批量隐藏元素（那会连正文容器一起干掉）。
     */
    function hideBadges(pages) {
        if (!document.body) return;
        const protect = new Set();
        pages.forEach(p => {
            let e = p;
            while (e) { protect.add(e); e = e.parentElement; }
        });

        const candidates = document.body.querySelectorAll('div,span,p,section,aside,button,label');
        for (const el of candidates) {
            if (protect.has(el) || el.id === BTN_ID || el.id === DIAG_ID || el.id === TOAST_ID) continue;
            const t = (el.textContent || '').trim();
            if (!t || t.length > 60 || !BADGE_RE.test(t)) continue;
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.width <= 340 && r.height <= 140) {
                el.classList.add(BADGE_CLASS);
            }
        }
    }

    /**
     * 打印时隐藏水印。
     *
     * 注意两点（都是踩过的雷）：
     *  1. 绝不用 el.remove()。那是不可逆的 —— 一旦某天误命中「包裹着简历的容器」，
     *     内容会被永久删掉，刷新都救不回来（v3 的空白 bug 就是这么来的）。
     *     这里只挂一个「仅打印态生效」的隐藏类，打印结束由 restorePrintLayout() 摘掉。
     *  2. 明确跳过「祖先」：若某元素内部**包含**页元素，说明它是简历的外壳，一律不碰。
     *     宁可漏隐藏一个水印，也不能动简历本身。
     */
    function hideWatermarks(pages) {
        if (!CONFIG.hideWatermark) return 0;
        let n = 0;
        document.querySelectorAll('[class*="watermark"], [id*="watermark"]').forEach(el => {
            if (pages.some(p => el !== p && el.contains(p))) return;  // 是简历祖先，跳过
            el.classList.add(BADGE_CLASS);
            n++;
        });
        return n;
    }

    /* ---------------------------------------------------------------------
     * 4. 打印主流程
     * ------------------------------------------------------------------- */
    let printing = false;

    function runPrint() {
        const pages = applyPrintLayout();

        if (!pages) {
            toast('没找到简历内容。\n请先进入简历预览页（能看到白色纸张）再点导出。', true);
            return;
        }

        let msg = `检测到 ${pages.length} 页\n正在唤起打印…`;
        if (lastOverflow.length) {
            msg += `\n⚠️ 第 ${lastOverflow.join(' / ')} 页内容超出一页 A4，`
                 + `超出部分会被裁掉，请先在 CodeCV 里精简该页`;
            console.warn('[CodeCV] 内容超出一页 A4 的页码：', lastOverflow);
        }
        toast(msg, lastOverflow.length > 0);

        requestAnimationFrame(() => {
            setTimeout(() => {
                if (printing) return;
                printing = true;
                window.print();
                setTimeout(() => { printing = false; restorePrintLayout(); }, 1500);
            }, 60);
        });
    }

    /* ---------------------------------------------------------------------
     * 5. UI
     * ------------------------------------------------------------------- */
    function toast(msg, warn) {
        let el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement('div');
            el.id = TOAST_ID;
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.className = 'show' + (warn ? ' warn' : '');
        clearTimeout(el._t);
        el._t = setTimeout(() => { el.className = warn ? 'warn' : ''; }, 3200);
    }

    function mountButtons() {
        if (document.body && !document.getElementById(BTN_ID)) {
            const btn = document.createElement('button');
            btn.id = BTN_ID;
            btn.type = 'button';
            btn.textContent = '🖨️ 导出完美简历';
            btn.title = '一键导出 A4 无水印 PDF（支持多页）';
            btn.addEventListener('click', runPrint);
            document.body.appendChild(btn);
        }
        if (document.body && !document.getElementById(DIAG_ID)) {
            const d = document.createElement('button');
            d.id = DIAG_ID;
            d.type = 'button';
            d.textContent = '诊断';
            d.title = '点一下：把页面结构信息复制到剪贴板（导出有问题时用）';
            d.addEventListener('click', dump);
            document.body.appendChild(d);
        }
    }

    /* ---------------------------------------------------------------------
     * 6. 钩子：直接按 Ctrl+P 也生效
     * ------------------------------------------------------------------- */
    window.addEventListener('beforeprint', () => { applyPrintLayout(); });
    window.addEventListener('afterprint', () => {
        printing = false;
        restorePrintLayout();
    });

    /* ---------------------------------------------------------------------
     * 7. 诊断 dump —— 点「诊断」按钮即可，会把结构复制到剪贴板
     * ------------------------------------------------------------------- */
    function describe(el) {
        if (!el) return 'null';
        let cls = '';
        try {
            cls = (typeof el.className === 'string' ? el.className : '').trim().replace(/\s+/g, '.');
        } catch (e) { cls = ''; }
        return el.tagName.toLowerCase() + (cls ? '.' + cls.slice(0, 90) : '');
    }

    function dump() {
        const pages = detectPages();
        const L = [];
        const push = s => L.push(s);

        push('===== CodeCV 导出脚本 结构诊断 (v4.1) =====');
        push('URL: ' + location.href);
        push('窗口: ' + window.innerWidth + 'x' + window.innerHeight +
             '  dpr=' + window.devicePixelRatio);
        push('探测到页数: ' + pages.length);
        if (pages.length) {
            const of = checkOverflow(pages);
            push('内容超出一页 A4 的页码: ' + (of.length ? of.join(', ') + '  ← 这些页会被裁掉' : '无'));
        }
        push('');

        if (!pages.length) push('!! 没探测到页元素，请检查 CONFIG.pageSelector');

        pages.forEach((el, i) => {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            push(`--- 第 ${i + 1} 页 ---`);
            push('  选择器: ' + describe(el));
            push(`  rect: top=${r.top.toFixed(0)} left=${r.left.toFixed(0)} ` +
                 `w=${r.width.toFixed(0)} h=${r.height.toFixed(0)}`);
            push(`  offsetTop=${el.offsetTop} offsetLeft=${el.offsetLeft}`);
            push(`  position=${cs.position} top=${cs.top} left=${cs.left} ` +
                 `height=${cs.height} overflow=${cs.overflow}`);
            push(`  transform=${cs.transform}`);
            push(`  margin=${cs.margin}`);
            push(`  padding=${cs.padding}`);
            push(`  offsetParent: ${describe(el.offsetParent)}`);
            push(`  父节点: ${describe(el.parentElement)}`);
            push(`  文本开头: ${(el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 45)}`);
        });

        if (pages.length) {
            push('');
            push('--- 第 1 页的祖先链（往上到 body）---');
            let el = pages[0].parentElement;
            let d = 0;
            while (el && el !== document.body && d < 12) {
                const cs = getComputedStyle(el);
                push(`  ${'.'.repeat(d)}${describe(el)}  position=${cs.position} ` +
                     `height=${cs.height} overflow=${cs.overflow} ` +
                     `transform=${cs.transform} bg=${cs.backgroundColor} margin=${cs.margin}`);
                el = el.parentElement;
                d++;
            }
            const bcs = getComputedStyle(document.body);
            push(`  body  margin=${bcs.margin} bg=${bcs.backgroundColor} ` +
                 `scrollHeight=${document.body.scrollHeight}`);
        }

        push('');
        push('--- 深色大块背景（排查页间黑条）---');
        let dark = 0;
        if (document.body) {
            for (const el of document.body.querySelectorAll('*')) {
                const cs = getComputedStyle(el);
                const m = cs.backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
                if (!m) continue;
                const lum = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
                const r = el.getBoundingClientRect();
                if (lum < 130 && r.width > 300 && r.height > 20) {
                    push(`  ${describe(el)}  bg=${cs.backgroundColor} ` +
                         `size=${r.width.toFixed(0)}x${r.height.toFixed(0)}`);
                    if (++dark >= 12) break;
                }
            }
        }
        if (!dark) push('  （无）');

        push('');
        push('--- position:fixed / sticky 元素（仅列出，供排查浮层）---');
        let fx = 0;
        if (document.body) {
            for (const el of document.body.querySelectorAll('*')) {
                const cs = getComputedStyle(el);
                if (cs.position === 'fixed' || cs.position === 'sticky') {
                    const t = (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 28);
                    const r = el.getBoundingClientRect();
                    push(`  ${describe(el)}  ${cs.position} ` +
                         `${r.width.toFixed(0)}x${r.height.toFixed(0)} 文本=${t}`);
                    if (++fx >= 20) break;
                }
            }
        }
        if (!fx) push('  （无）');

        push('');
        push('===== 诊断结束 =====');

        const text = L.join('\n');
        console.log(text);
        try {
            navigator.clipboard.writeText(text).then(
                () => toast('诊断信息已复制到剪贴板，直接粘贴发我即可'),
                () => toast('已输出到控制台，请手动复制（F12 → Console）', true)
            );
        } catch (e) {
            toast('已输出到控制台，请手动复制（F12 → Console）', true);
        }
        return text;
    }

    window.__codecvExport = {
        print: runPrint,
        dump: dump,
        detectPages: detectPages,
        checkOverflow: checkOverflow,  // 返回「内容超出一页 A4」的页码数组
        layout: applyPrintLayout,      // 手动套用打印布局（不弹打印框）
        restore: restorePrintLayout,   // 手动还原（排错用）
        config: CONFIG
    };

    /* ---------------------------------------------------------------------
     * 8. 启动
     * ------------------------------------------------------------------- */
    function boot() {
        if (!document.body) { setTimeout(boot, 100); return; }
        mountButtons();
        if (CONFIG.debug) console.log('[CodeCV] 就绪，页数 =', detectPages().length);
    }

    if (document.body) boot();
    else document.addEventListener('DOMContentLoaded', boot);
})();
