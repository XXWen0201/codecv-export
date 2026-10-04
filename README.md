<div align="center">

<img src="icons/icon128.png" width="96" height="96" alt="CodeCV 导出图标">

# CodeCV 简历一键无水印导出（多页修复版）

在 [CodeCV](https://www.codecvcv.com) 简历预览页，一键把简历导出成 A4 高清 PDF。

**修复了原版「多页简历只导出最后一页」的问题。**

</div>

---

## 一键安装

**第 1 步**　浏览器先装好 [Tampermonkey](https://www.tampermonkey.net/)（油猴扩展，Chrome / Edge / Firefox 都有，装一次就够）。

**第 2 步**　点下面的链接：

### 👉 [点此安装脚本](https://cdn.jsdelivr.net/gh/XXWen0201/codecv-export@main/codecv-export.user.js)

Tampermonkey 会自动弹出安装页面，点「安装」即可。装好之后脚本会跟随本仓库自动更新。

> **装过旧版本？** 如果你之前手动复制粘贴装过别的版本，请先在 Tampermonkey 仪表盘里**删掉旧的**，再点上面的链接。否则新旧两版会同时运行，页面上会出现两个按钮。

### 备选安装方式

| 方式 | 地址 | 说明 |
|---|---|---|
| **jsDelivr（推荐）** | [链接](https://cdn.jsdelivr.net/gh/XXWen0201/codecv-export@main/codecv-export.user.js) | 国内可直接访问，跟随 `main` 分支自动更新 |
| GitHub Raw | [链接](https://raw.githubusercontent.com/XXWen0201/codecv-export/main/codecv-export.user.js) | 官方源；国内部分网络需要自备网络环境 |
| 固定版本 | `https://cdn.jsdelivr.net/gh/XXWen0201/codecv-export@v4.1.0/codecv-export.user.js` | 锁定 4.1.0，不随仓库更新 |
| 手动粘贴 | — | 见下方「手动安装」 |

<details>
<summary><b>手动安装（兜底方案）</b></summary>

1. 打开 Tampermonkey 仪表盘 → 「实用工具」→ 「从 URL 安装」，粘贴上面的 jsDelivr 链接；
2. 或者：新建脚本 → 清空模板 → 粘贴本仓库 `codecv-export.user.js` 的全部内容 → `Ctrl+S`。

</details>

---

## 怎么用

1. 打开 CodeCV，进入你的简历预览页（能看到白色纸张那一页）。
2. 页面**左侧中间**会出现一个竖条按钮 **「🖨️ 导出完美简历」**，点它。
3. 浏览器打印对话框里这样设置：

   | 选项 | 设为 |
   |---|---|
   | 目标打印机 | **另存为 PDF** |
   | 纸张 | **A4** |
   | 边距 | **无**（默认也行） |
   | 背景图形 | **勾选**（否则部分色块会丢） |

4. 保存。

**也可以直接按 `Ctrl+P`** —— 脚本挂了 `beforeprint` 钩子，走浏览器原生打印同样会应用修复后的排版。

### 附带的「诊断」按钮

主按钮下方还有一个小的 **「诊断」** 按钮。点一下会把当前页面的结构信息复制到剪贴板：每页元素的类名、`position` / `top` / 高度、祖先链、疑似水印与浮层清单。

站点改版导致脚本失效时，把它粘贴到 [Issues](https://github.com/XXWen0201/codecv-export/issues) 里，能大幅缩短定位时间。

### 控制台 API

在简历页按 `F12` 打开控制台：

| 命令 | 作用 |
|---|---|
| `__codecvExport.print()` | 等价于点导出按钮 |
| `__codecvExport.dump()` | 打印并复制完整结构诊断 |
| `__codecvExport.detectPages()` | 返回被识别为「页」的元素列表 |
| `__codecvExport.checkOverflow(pages)` | 返回**内容超出一页 A4** 的页码数组 |
| `__codecvExport.layout()` / `.restore()` | 手动套用 / 还原打印排版（排错用） |

---

## 它为什么坏，又为什么修好了

### 原版的 bug

原脚本的打印样式里有这么一段：

```css
.re-render, .jufe-wrapper-page, .jufe-wrapper-page-item {
    position: absolute !important;
    top: 0 !important; left: 0 !important;   /* ← 元凶 */
}
```

`.jufe-wrapper-page-item` 就是**每一页**。它们本来在文档流里依次往下排，被强制 `absolute` + `top: 0` 之后，**所有页都叠在同一个坐标上**，DOM 里靠后的那页盖在上面 —— 于是两页简历只导出最后一页。

同一个 bug 家族还有第二个坑：`height: 297mm !important` 会把超出一页的内容**静默裁掉**，页数看着正常，内容却少了。

### 修复方式

**只改一处**：把每一页的 `top` 从「全部 0」改成「第 n 页 = (n-1) × 297mm」。

```js
pages.forEach((el, i) => {
    el.style.setProperty('top', (i * 297) + 'mm', 'important');
});
```

父容器的 `position` 一律不动 —— 这一点是踩了两次坑才总结出来的（把父层改成 `static` 会导致内容重复、错位、露黑底）。分页交给「每页错开到各自的 A4 位置上」，而不是靠浏览器自动分页。

字体、间距、颜色、页内布局全部沿用站点原本的渲染结果，**只挪位置，不重排版**。

### 顺带修掉的三处隐患

| # | 问题 | 处理 |
|---|---|---|
| 1 | 原脚本用 `el.remove()` 直接删水印 DOM —— 不可逆，一旦误命中包裹内容的容器就会**永久删掉内容** | 改为「打印时隐藏 + 打印后恢复」，并跳过包含页元素的祖先 |
| 2 | 还原 `top` 时丢失 `!important` 优先级，连续导出可能不一致 | 连优先级一起存、一起还原 |
| 3 | 内容超过一页 A4 时**静默从 PDF 里消失**，无任何提示 | 导出时检测并在页面底部弹出告警，同时 `console.warn` |

第 3 条**修不掉**（放开高度只会让内容盖到下一页上，更糟），所以选择明确告警：如果你看到红条提示某页超长，说明那页在 CodeCV 里本来就装不下，需要先精简内容。

---

## 常见问题

**Q：导出的 PDF 少了内容 / 有红条告警？**
那页内容超过了 A4 能容纳的高度。CodeCV 的预览层是固定高度的，超出部分不会进入打印输出。先精简该页内容（或拆成两页）再导出。

**Q：页数对了，但内容重复、错位、页间有黑条？**
这是早期版本的已知问题（改坏了站点的定位容器）。请确认你装的是 **v4.1.0 及以上**版本。

**Q：页面上没出现按钮？**
1. 确认当前 URL 是 `codecvcv.com/cv/*` 简历预览页；
2. 装完脚本后**刷新页面**（按钮在页面加载时挂载）；
3. 检查 Tampermonkey 是否已启用该脚本。

**Q：水印还在？**
脚本只匹配类名/ID 含 `watermark` 的元素和「校验 / 防伪 / 仅供预览」这类小徽标。如果站点换了命名，点「诊断」按钮把结构发到 Issues。

**Q：它会把我简历传到哪儿去吗？**
不会。脚本只有 `@grant none`，不发任何网络请求，不读 Cookie，不碰账号凭据。它只操作**你自己浏览器里已经渲染出来的 DOM**。

**Q：能导出 Word / 图片吗？**
不能，只做 PDF。想改内容请在 CodeCV 里改，或导出后自行转换。

**Q：站点改版了怎么办？**
所有选择器集中在脚本顶部的 `CONFIG` 对象里，改这一处即可。也欢迎提 Issue。

---

## 开发与验证

仓库自带端到端验证脚本：它把**真实的 `codecv-export.user.js`** 注入模拟页面，用无头 Chrome/Edge 打印成 PDF，再用 pypdf 逐页校验文本。

```bash
python test/verify_e2e.py 1 2 3 5      # 模拟 1/2/3/5 页简历
python test/verify_e2e.py 2 --long     # 压力测试：内容远超一页 A4
```

依赖：本机已安装的 Chrome 或 Edge + `pypdf`。

**它是怎么保证测试有效的**：页数对不代表脚本生效（不注入打印样式时页数也可能碰巧对上），所以模拟页里埋了三个「诱饵」元素 —— 只有脚本真的执行了，它们才会从 PDF 里消失。任何一条诱饵出现在 PDF 文本中，就说明对应的逻辑没生效。

当前状态：1 / 2 / 3 / 5 页用例全绿，诱饵全灭，还原后 DOM 干净。

---

## 许可与致谢

- 原脚本：[CodeCV 简历一键无水印导出](https://greasyfork.org/scripts/575852) © Campus，MIT License
- 本仓库：多页修复及后续修改 © XXWen0201，同样以 MIT License 发布

MIT 允许修改与再发布，但要求保留原作者的版权声明。本仓库的 `LICENSE` 中已同时保留两份署名。

## 免责声明

- 脚本只处理**你自己本机已经渲染出来的简历内容**，不构造请求、不绕过付费墙、不批量抓取、不对外分发。
- 如果 CodeCV 未来改为在**服务端**往导出文件里烧水印，本脚本无能为力。
- 站点 DOM 结构一旦改版，脚本可能失效。文中的选择器实测自脚本编写时的站点结构，改版后需要重新验证。
