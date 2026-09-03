# ScreenDeck 🎴

吸附在 MacBook 刘海上的"抽屉"。鼠标指向刘海，任务面板像纸张一样从顶部铺开——不打断你正在做的事。

**直接读写 Obsidian vault，零依赖、零后台进程、双击即用。**

```
┌─ 收起态 ─────────────────┐   ┌─ 展开态 ─────────────────────┐
│ ██ 刘海（视觉无痕）        │   │ ██ 刘海把手                   │
│                           │   │ ────────────────────────     │
│   鼠标指向刘海 → 抽屉探出   │   │ ☑ 今日主要任务        5/19 ⌃  │
│                           │   │ ○ 编写今日工作日报             │
│                           │   │ ● 发布知识引用展示             │
└───────────────────────────┘   │ ○ 规范mcp接入功能和统一方式     │
                                │ ...（点击即勾选，写回日记）     │
                                └───────────────────────────────┘
```

## 快速开始

```bash
# 依赖：macOS 14+、Swift 6（Xcode 26+）
swift run ScreenDeck
```

环境变量（可选）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `SCREENDECK_VAULT` | `~/Obsidian/星宫` | Obsidian vault 路径 |
| `SCREENDECK_TASK_SECTION` | `今日主要任务` | 只显示该 `##` 章节的任务；空字符串 = 全部 |

用 Xcode 打开 `Package.swift` 也可以直接跑/调试。

## 核心特性

- **三态抽屉**：收起（=刘海本身）→ 探出（拉开一条缝）→ 展开（纸张铺开）
- **严格触发**：只有鼠标在刘海矩形（74×37）内才展开，其余区域不误触
- **直接读写**：无需桥服务，App 直读 Obsidian 日记文件，2 秒轮询同步
- **任务勾选**：点击任务切换 `- [ ]` / `- [x]`，只改那一行的标记，行尾/其余内容原样保留
- **章节过滤**：只显示配置的 `##` 章节（嵌套子任务保留缩进）
- **菜单栏常驻**：无 Dock 图标，`☑` 菜单栏图标可手动展开/收起/退出

## 目录结构

```
ScreenDeck/
├── Package.swift              ← SPM 清单
├── Sources/ScreenDeck/
│   ├── App/                   ← 应用入口、菜单栏与全局状态
│   ├── Features/Deck/         ← 面板 UI、窗口与鼠标热区
│   ├── Models/                ← 任务数据模型
│   └── Services/Obsidian/     ← Obsidian vault 直读/写
└── Tests/ScreenDeckTests/
    ├── Models/                ← 数据模型测试
    └── Services/              ← Vault 解析与写入测试
```

## 架构

```
ScreenDeck (SwiftUI)
    ↕ 直接文件读写（无 HTTP、无中间服务）
Obsidian vault
    ├── .obsidian/daily-notes.json   ← 日记位置/格式配置
    └── 日记/2026/08/2026-08-20.md   ← 任务数据源
```

设计细节、交互哲学与决策记录见 [DESIGN.md](DESIGN.md)。

## Roadmap

- [ ] 吸附位置可配置（左/右/底部边缘）
- [ ] 面板内新增任务/文本编辑
- [ ] 自有数据模式（不依赖 Obsidian）+ CloudKit 同步（Mac+iOS）
- [ ] Obsidian 文件夹双向同步（Pro 功能）
- [ ] 开机自启（LaunchAgent）
- [ ] 商业化（见 DESIGN.md）
