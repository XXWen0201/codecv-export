# -*- coding: utf-8 -*-
"""
codecv-export.user.js 端到端验证
==========================================================================
与之前 build_and_test.py 的区别（这才是真正的验收）：

  之前：测的是我手抄的 CSS 常量 —— 脚本改了 CSS，测试却不会跟着变。
  现在：把 **真实的 codecv-export.user.js 文件原文** 注入模拟页面，
        由脚本自己去注入样式、自己去跑 applyPrintLayout()，再交给无头 Chrome
        真实打印成 PDF，最后用 pypdf 逐页校验文本。

页数对 ≠ 脚本生效（模拟页不注入打印 CSS 时，A4 上一页放不下两页，页数也会对）。
所以页面里埋了三个「诱饵」，只有脚本真的生效它们才会消失：

  诱饵 1  .operator        文本 OP-LEAK-...   → 脚本的隐藏列表里点名了它
  诱饵 2  .verify-badge    文本「正在校验第 2 页」→ 走 hideBadges() 文字特征匹配
  诱饵 3  .watermark       文本「CodeCV 水印」    → 走 hideWatermarks()

任何一条诱饵在 PDF 里被提取到，就说明对应的那段逻辑没生效。

用法：python verify_e2e.py [页数...]      默认 1 2 3 5
"""
import pathlib
import re
import subprocess
import sys
import tempfile

BASE = pathlib.Path(__file__).resolve().parent

SCRIPT_CANDIDATES = [
    pathlib.Path(__file__).resolve().parent.parent / "codecv-export.user.js",
]

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

# ---------------------------------------------------------------------------
# 模拟页面的「屏幕态」样式：复刻 CodeCV 预览页的 DOM 层级与观感
# 注意：这里刻意 **不写任何 @media print**，打印样式只能由被测脚本自己注入。
# ---------------------------------------------------------------------------
SCREEN_CSS = """
  * { box-sizing: border-box; }
  body { margin: 0; background: #eef0f3; font-family: "Microsoft YaHei", system-ui, sans-serif; }
  #__nuxt { padding: 20px 0; }
  .preview-cv { display: flex; justify-content: center; }
  .el-scrollbar__wrap { overflow: hidden; }
  .el-scrollbar__view { overflow: hidden; }
  .re-render { position: relative; }
  .jufe-wrapper-page { position: relative; }

  .jufe-wrapper-page-item {
    position: relative;
    width: 210mm; height: 297mm;
    margin: 0 auto 18px;
    background: #fff;
    box-shadow: 0 2px 10px rgba(0, 0, 0, .15);
    overflow: hidden;
  }
  .markdown-transform-html { padding: 8mm 12mm; }
  .body { min-height: 250mm; }

  h1 { font-size: 16pt; margin: 0 0 10px; }
  h2 { font-size: 12pt; margin: 14px 0 6px; border-bottom: 1px solid #ddd; padding-bottom: 3px; }
  p  { font-size: 10pt; line-height: 1.8; margin: 0 0 6px; color: #333; }

  /* 诱饵 3：水印（在页内部，绝对定位盖在纸上） */
  .watermark { position: absolute; right: 10mm; bottom: 10mm; font-size: 20pt; color: #f00; opacity: .35; }

  /* 诱饵 2：类似「正在校验第 N 页」的小徽标（页外的固定浮层） */
  .verify-badge {
    position: fixed; right: 24px; bottom: 24px; z-index: 99999;
    padding: 6px 12px; border-radius: 6px;
    background: rgba(0,0,0,.75); color: #fff; font-size: 12px;
  }

  /* 诱饵 1：脚本隐藏列表里点名的干扰层 */
  .operator {
    height: 60px; line-height: 60px; margin: 12px 0;
    background: #ffe9e3; color: #b33; font-size: 11pt; text-align: center;
  }
"""

PAGE_TPL = """            <div class="jufe-wrapper-page-item">
              <div class="markdown-transform-html">
                <div class="body">
                  <h1>文嘉仪 · Java 后端开发工程师</h1>
                  <p><b>【第 {i} 页 / 共 {total} 页】</b>本页用于验证多页导出是否完整保留。</p>
                  <h2>教育背景</h2>
                  <p>湖南女子学院 · 计算机科学与技术（专升本）2025.09 - 2027.07</p>
                  <h2>技术栈</h2>
                  <p>Java 21 / Spring Boot 3 / MyBatis-Plus / MySQL / Redis / Spring AI / LangChain4j</p>
                  <h2>项目经历</h2>
                  <p>多智能体平台 dodo-agent：Spring AI 双模式、MCP 工具协议、SSE 消息协议。</p>
                  <div class="watermark">CodeCV 水印</div>
                </div>
              </div>
            </div>"""

DECOYS = """  <div class="operator">OP-LEAK-此层若出现在 PDF 说明脚本隐藏列表没生效</div>
  <div class="verify-badge">正在校验第 2 页</div>"""

# 探针用：把每页内容撑到远超一页 A4，看脚本是「裁掉」还是「溢出到下一页」
LONG_EXTRA = """
                  <h2>超长内容压力测试</h2>
""" + "".join(
    f"                  <p>压力测试第 {k} 段：Java / Spring / MySQL / Redis / 分布式 / 高并发。</p>\n"
    for k in range(1, 46)
)

DOC_TPL = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>CodeCV 导出脚本 端到端验证</title>
<style>{screen_css}</style>
</head>
<body>
<div id="__nuxt">
  <div id="main" class="flex">
    <div class="preview-cv">
      <div class="el-scrollbar__wrap">
        <div class="el-scrollbar__view">
          <div class="re-render">
            <div class="jufe-wrapper-page">
{page_items}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
{decoys}
<script>
{script}
</script>
<script>
/* 1) 先量「有没有哪页内容超出一页 A4」—— 这一步必须在套用打印样式之前，
      与脚本内部 applyPrintLayout() 的顺序一致，否则量不准 */
(function () {{
  var of = [];
  var pages0 = document.querySelectorAll('.jufe-wrapper-page-item');
  Array.prototype.forEach.call(pages0, function (el, i) {{
    if (el.clientHeight > 100 && el.scrollHeight > el.clientHeight + 2) of.push(i + 1);
  }});
  document.documentElement.setAttribute('data-probe',
    'client=' + (pages0[0] ? pages0[0].clientHeight : -1) +
    ';scroll=' + (pages0[0] ? pages0[0].scrollHeight : -1) +
    ';expectOverflow=' + of.join('|'));
}})();

/* 2) 触发脚本注册的 beforeprint 钩子 —— 与真实「Ctrl+P / window.print()」同一条代码路径 */
window.dispatchEvent(new Event('beforeprint'));

/* 3) 把运行时状态写进 DOM 属性（--dump-dom 才能拿到真实值，而不是源码文本） */
(function () {{
  var pages = document.querySelectorAll('.jufe-wrapper-page-item');
  var tops = Array.prototype.map.call(pages, function (el) {{
    return el.style.getPropertyValue('top');
  }}).join('|');
  document.documentElement.setAttribute('data-verify',
    'detected=' + (window.__codecvExport ? window.__codecvExport.detectPages().length : -1) +
    ';marked=' + document.querySelectorAll('.codecv-print-page').length +
    ';tops=' + tops +
    ';hidden=' + document.querySelectorAll('.codecv-hide-badge').length +
    ';overflow=' + (window.__codecvExport
        ? window.__codecvExport.checkOverflow(window.__codecvExport.detectPages()).join('|') : 'NA') +
    ';bodyAlive=' + (!!document.body && document.body.textContent.length > 100) +
    ';api=' + Object.keys(window.__codecvExport || {{}}).join(',')
  );
  /* 打印结束后必须干净还原：inline top 清掉、标记类摘掉、内容一根毫毛都不能少 */
  window.dispatchEvent(new Event('afterprint'));
  document.documentElement.setAttribute('data-restore',
    'tops=' + Array.prototype.map.call(pages, function (el) {{
      return el.style.getPropertyValue('top') || '-';
    }}).join('|') +
    ';marked=' + document.querySelectorAll('.codecv-print-page').length +
    ';hidden=' + document.querySelectorAll('.codecv-hide-badge').length +
    ';watermark=' + document.querySelectorAll('[class*="watermark"]').length +
    ';bodyAlive=' + (!!document.body && document.body.textContent.length > 100)
  );
}})();
</script>
</body>
</html>
"""


def find_script():
    for p in SCRIPT_CANDIDATES:
        if p.exists():
            return p
    raise SystemExit("找不到 codecv-export.user.js")


def find_browser():
    for p in CHROME_CANDIDATES:
        if pathlib.Path(p).exists():
            return p
    return None


def build(total, out_path, script_text, long_mode=False):
    extra = LONG_EXTRA if long_mode else ""
    anchor = '                  <div class="watermark">'
    items = "\n".join(
        # 锚点必须落在 .body 的普通流里，不能切在水印自己的 </div> 上
        # （水印是 position:absolute，塞进去撑不开页面，探针会失效）
        PAGE_TPL.format(i=i, total=total).replace(anchor, extra + anchor, 1)
        for i in range(1, total + 1)
    )
    html = DOC_TPL.format(
        screen_css=SCREEN_CSS,
        page_items=items,
        decoys=DECOYS,
        script=script_text,
    )
    out_path.write_text(html, encoding="utf-8")
    return out_path


def render(browser, html_path, pdf_path, dump_dom_path=None):
    profile = pathlib.Path(tempfile.mkdtemp(prefix="cvverify_"))
    if pdf_path.exists():
        pdf_path.unlink()
    if dump_dom_path and dump_dom_path.exists():
        dump_dom_path.unlink()

    common = [browser, "--headless=new", "--disable-gpu", "--no-sandbox",
              f"--user-data-dir={profile}", "--virtual-time-budget=4000",
              "--window-size=1280,1400"]

    # 1) 打印成 PDF
    args = common + ["--no-pdf-header-footer", f"--print-to-pdf={pdf_path}", html_path.as_uri()]
    r = subprocess.run(args, capture_output=True, timeout=180)
    if not pdf_path.exists():
        raise RuntimeError("PDF 生成失败:\n" + r.stderr.decode("utf-8", "ignore")[-1200:])

    # 2) 顺带 dump DOM，拿 __verify 里的 JS 运行结果（证明 inline top 真的写进去了）
    if dump_dom_path:
        args2 = common + ["--dump-dom", html_path.as_uri()]
        r2 = subprocess.run(args2, capture_output=True, timeout=180)
        dump_dom_path.write_bytes(r2.stdout)
    return r


def read_pages(pdf_path):
    from pypdf import PdfReader
    reader = PdfReader(str(pdf_path))
    texts = []
    for pg in reader.pages:
        t = (pg.extract_text() or "")
        texts.append(re.sub(r"\s+", " ", t).strip())
    return texts


def main():
    script_path = find_script()
    browser = find_browser()
    if not browser:
        print("找不到 Chrome/Edge")
        return 1

    script_text = script_path.read_text(encoding="utf-8")
    if "</script" in script_text.lower():
        raise SystemExit("脚本内含 </script，无法内联注入")

    totals = [int(a) for a in sys.argv[1:] if a.strip().isdigit()] or [1, 2, 3, 5]
    long_mode = "--long" in sys.argv

    print(f"被测脚本: {script_path}")
    print(f"浏览器  : {browser}")
    if long_mode:
        print("模式    : 压力测试（每页内容远超一页 A4）")
    print()

    allok = True
    rows = []

    for total in totals:
        tag = f"e2e-{total}" + ("-long" if long_mode else "")
        html = build(total, BASE / f"{tag}.html", script_text, long_mode)
        pdf = BASE / f"{tag}.pdf"
        dom = BASE / f"{tag}.dom.html"
        render(browser, html, pdf, dom)

        texts = read_pages(pdf)
        n = len(texts)
        joined = " ".join(texts)

        # --- 断言 ---
        checks = []
        checks.append((f"页数 = {total}", n == total, f"实际 {n} 页"))
        for i in range(1, total + 1):
            checks.append((f"第 {i} 页文本在位", f"第 {i} 页" in joined, ""))
        checks.append(("内容不重复", joined.count("教育背景") == total,
                       f"出现 {joined.count('教育背景')} 次"))
        checks.append(("诱饵1 干扰层已隐藏", "OP-LEAK" not in joined, ""))
        checks.append(("诱饵2 校验徽标已隐藏", "正在校验" not in joined, ""))
        checks.append(("诱饵3 水印已隐藏", "水印" not in joined, ""))

        dom_text = dom.read_text(encoding="utf-8", errors="ignore")
        m = re.search(r'data-verify="([^"]*)"', dom_text)
        verify = m.group(1) if m else "(未取到)"

        # 运行时证据：inline top 必须逐页错开，否则说明 JS 路径没真的跑起来
        tops = ""
        if m:
            tm = re.search(r"tops=([^;]*)", verify)
            tops = tm.group(1) if tm else ""
        expect_tops = "|".join(f"{i * 297}mm" for i in range(total))
        checks.append((f"inline top 逐页错开", tops == expect_tops,
                       f"实际 {tops or '(空)'}"))

        # 超出一页 A4 的探测：正常内容不能误报，超长内容必须报出来
        om = re.search(r"overflow=([^;]*)", verify)
        got_of = om.group(1) if om else "NA"
        prm = re.search(r'data-probe="([^"]*)"', dom_text)
        probe = prm.group(1) if prm else "(未取到)"
        pm = re.search(r"expectOverflow=([^;\"]*)", probe)
        probe_of = pm.group(1) if pm else "?"
        if long_mode:
            checks.append(("超长内容能被检出（告警生效）",
                           got_of != "" and got_of == probe_of,
                           f"脚本检出 [{got_of}] / 独立探针 [{probe_of}]"))
        else:
            checks.append(("正常内容无误报", got_of == "", f"脚本检出 [{got_of}]"))

        # 还原干净度：打印后不能留下任何痕迹（状态污染会污染下一次导出）
        rm = re.search(r'data-restore="([^"]*)"', dom_text)
        restore = rm.group(1) if rm else "(未取到)"
        if rm:
            r_tops = re.search(r"tops=([^;]*)", restore)
            r_marked = re.search(r"marked=(\d+)", restore)
            r_hidden = re.search(r"hidden=(\d+)", restore)
            r_wm = re.search(r"watermark=(\d+)", restore)
            checks.append(("还原后 top 已清空",
                           r_tops and set(r_tops.group(1).split("|")) == {"-"}, ""))
            checks.append(("还原后标记类已摘除",
                           r_marked and r_marked.group(1) == "0", ""))
            checks.append(("还原后隐藏类已摘除",
                           r_hidden and r_hidden.group(1) == "0", ""))
            checks.append(("还原后水印元素仍存在（没被删）",
                           r_wm and int(r_wm.group(1)) == total,
                           f"剩 {r_wm.group(1) if r_wm else '?'} / 期望 {total}"))
            checks.append(("还原后内容仍完整",
                           "bodyAlive=true" in restore, ""))

        ok = all(c[1] for c in checks)
        allok = allok and ok
        rows.append((total, n, ok, pdf.stat().st_size))

        print(f"===== 模拟简历 {total} 页{'（压力测试）' if long_mode else ''} =====")
        for name, passed, note in checks:
            print(f"  {'✅' if passed else '❌'} {name}" + (f"   {note}" if note else ""))
        print(f"  · 独立探针: {probe}")
        print(f"  · 脚本状态: {verify}")
        print()

    print("=" * 66)
    for total, n, ok, size in rows:
        print(f"  {total} 页简历 -> PDF {n} 页  {size/1024:6.1f}KB   {'✅' if ok else '❌'}")
    print("=" * 66)
    return 0 if allok else 2


if __name__ == "__main__":
    sys.exit(main())
