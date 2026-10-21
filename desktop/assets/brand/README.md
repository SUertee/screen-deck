# ScreenDeck 品牌资源

沿用 ScreenDeck 官网的 Fold 标志，不重画路径或调整相对比例。

- `screendeck-mark-black.svg`：透明独立标识。工作台和 Deck 共用 CSS mask，颜色跟随所在界面的正文颜色。
- `screendeck-icon-black.svg`：黑底白标的应用图标矢量原件。
- `screendeck-icon-black.png`：官网对应的 2048 × 2048 PNG 交付原件。开发态 Dock、窗口图标与 macOS ICNS 共用这份图像。

`build.mjs` 将 PNG 复制到 `dist/brand/`；界面 SVG 由 Vite 内联进样式，不增加自定义协议的可访问路径。`package-mac.mjs` 调用 `app-icon.mjs`，用 macOS 自带的 sips 生成既有七种尺寸的 ICNS，不再用像素函数重画标志。

更新品牌时同步替换官网对应的 SVG 与 PNG，并重新构建和打包。仅替换 SVG 不会自动更新已导出的 PNG。官网文件保持只读；此处保存可独立构建的本地副本。
