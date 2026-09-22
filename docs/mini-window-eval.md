# 迷你浮窗评估（小窗播放器：失焦切歌 + 红星）

> 2026-09-22 · 纯评估，无代码改动。
> 方法：7 agent workflow（前端现状盘点 + Tauri 2 多窗口调研 + 托盘/SMTC 替代方案调研 → 综合 → 8 条承重论断 3 组对抗核验），核验出的措辞/版本修正已并入本文。发起背景：用户提出「小窗口浮窗，方便切歌加红星」。

## 结论速览

| 方案 | 成本 | 切歌 | 红心 | 增量内存 | 定位 |
| --- | --- | --- | --- | --- | --- |
| B 托盘菜单（tray-icon） | 1.5–2.5 天 | ✅ 右键两次点击 | ✅ CheckMenuItem | ≈0 | **先做** |
| C SMTC 媒体会话（mediaSession） | 0.5–1 天 | ✅ 媒体键全局生效 | ❌ 系统按钮集无 Like | 0 | **先做** |
| A 迷你浮窗（独立 WebviewWindow） | 4–6 天 | ✅ 一键 | ✅ | Win ≤30–50MB / macOS 50–100MB | 第二步按需 |
| D 维持现状 | 0 | ❌ | ❌ | 0 | 基线 |

**建议：分两步走。** 第一步 B+C（合计 2–3.5 天）覆盖「失焦时切歌 + 红心」全部诉求：媒体键全局切歌 + 托盘菜单红心，都是系统级入口，且与 M4 队列里已有的托盘/SMTC 完全重合，零弃置工作。第二步浮窗 A 等实际用下来仍缺「可见常驻面板」（封面/歌名/进度一目了然）再上，届时按 §浮窗骨架 的硬约束实施。

排序理由：

1. 红心是关键分叉——SMTC 按钮集合自 Win10 10240 至今没有 Like（见 §关键事实 #1），系统媒体 UI 永远做不了红心；托盘菜单以一半成本先补上红心入口。
2. 浮窗存在真实的数据丢失路径（双写者，见 #3），必须以「副窗零写路径」为硬约束，联调点最多（4–6 天）。
3. 刚完成封面缩略图内存优化，浮窗会新增独立 renderer 进程内存，与优化方向相悖。
4. 合规取向：托盘+SMTC 均为操作系统标准形态、低调非托管；托盘常驻略「显眼」，可仅播放时显示图标。

## 关键事实（对抗核验后）

1. **SMTC 没有红心键**：Windows SMTC 可交互按钮固定 10 个（Play / Pause / Stop / Record / FastForward / Rewind / Next / Previous / ChannelUp / ChannelDown），无 Like/Dislike。系统级媒体 UI 做不了红心；红心可落点=应用内 UI、托盘菜单、浮窗，另有任务栏缩略图工具栏（ITaskbarList3 ThumbBar）与全局快捷键等次选承载面。
2. **媒体键可能已免费可用**：WebView2（Chromium 73+）含 Hardware Media Key Handling，`<audio>` 播放时页面大概率已自动注册 SMTC。行动前先花 10 分钟实测当前版本：媒体键是否切歌、音量键气泡是否显示封面（决定方案 C 是「接管校准」还是「从零接入」）。
3. **浮窗的真实风险是双写者（数据丢失路径）**：Tauri 2 每窗口独立 JS context，副窗加载同一 bundle 得到独立 store 实例，会各自向 `bmuisc.snapshot.v3` 整包覆盖写；现有 `hydrated` 门控（store.ts:66、store.ts:75）只防启动窗口、不防第二窗口。store.ts:64-65 注释记录的正是同类「空状态覆盖快照」事故。若做浮窗，硬约束=**浮窗零写路径**：不 restore()、不 saveSnapshot()、不挂 flushSnapshot、不跑 patchMedia；快照唯一写者=主窗。
4. **防抢焦点**：Windows 用 `focusable: false`——tao 对非 FOCUSABLE 窗口加 WS_EX_NOACTIVATE，点击不激活窗口但鼠标消息照常到达 WebView2（按钮可点）；`acceptFirstMouse` 是 macOS-only。macOS 无 WS_EX_NOACTIVATE 等价物，浮窗点击必抢主窗焦点（M4 体验打折，或浮窗首版只发 Windows）。
5. **Win10 无原生圆角**：DWMWA_WINDOW_CORNER_PREFERENCE 需 Win11（build 22000 起，21H2）→ 浮窗需 transparent:true + CSS border-radius + shadow:false（undecorated+shadow 有 1px 白边；部分 WebView2 Runtime 版本创建时有白闪）。
6. **内存增量如实计入**：WebView2 同一 user data folder 共享同一 browser 进程；第二窗口增量上限约一个独立 renderer 进程（~30MB），浮窗与主窗同源，renderer 可能复用、实际更低（需实测）。macOS wry 未共享 WKProcessPool（每个 WebView 各建 WKWebViewConfiguration），约 50–100MB。
7. **窗口创建走 Rust async command**：Windows 在同步 command/event 回调里建窗口会死锁（wry#583），必须 async 或独立线程；Rust 侧创建不受 ACL 约束，主窗无需 create-webview-window 权限。
8. **ACL 收敛**：default.json 保持 windows:["main"] 不动；新建 capabilities/mini.json：windows:["mini"]，permissions 仅 core:event:default + core:window:allow-start-dragging（data-tauri-drag-region 走该命令）+ core:window:allow-close。
9. **托盘细节**：Cargo tauri features 开 `tray-icon`；CheckMenuItem.set_checked 动态跟随红心态；换封面托盘图标=前端 canvas 把 `_1c` 封面缩到 16/32px 取 RGBA → `Image::new_owned` + `TrayIcon::set_icon`（**set_icon/Image 不负责缩放**；若走 Rust 侧 from_bytes 解码需 image-png feature，且 B 站 WebP 封面需另引解码）。
10. **跨窗通道**：状态同步应走 emit / emitTo / listen（Tauri 官方支持、受 ACL 管理）。同 UDF 的 WebView2 中 BroadcastChannel / localStorage storage 事件技术上也跨窗可用（共享同一 browser 进程），但非 Tauri 受支持方案，不采用。
11. **全局快捷键是补充入口**（RegisterHotKey，失焦可用）：global-hotkey 的 register() 本就返回 Result，注册失败（已注册/冲突）需降级处理。媒体键不宜用全局快捷键占用（RegisterHotKey 独占，会抢掉系统其他应用的媒体键，且与 SMTC 路线冲突）。

## 方案 A（浮窗）架构骨架

1. **窗口**：Rust async command `create_mini_window`；`WebviewWindowBuilder` label="mini"，url `index.html?view=mini`，约 260×84，decorations:false、always_on_top:true、skip_taskbar:true、resizable:false、shadow:false、transparent:true、focusable:false、visible:false（建后按存档位置 show，避免闪跳）。
2. **前端复用**：同 bundle，main.tsx 按 `?view=mini` 分流渲染 MiniPlayer；`isMiniWindow` 常量在模块层门控三件事——跳过 restore()（App.tsx 启动恢复）、跳过 initEngine()（防第二 `<audio>` / AudioContext 双引擎）、跳过 onCloseRequested 的 flushSnapshot 挂载。
3. **状态镜像（主窗→浮窗，单向）**：换曲 `emitTo('mini','mini:track', {title, up, pageLabel, cover, liked, mode})` 一条全量 now-playing；playing/loading 变化 `mini:state`；进度 1s 节流推送，或浮窗本地自增估算、换曲校正（更省 IPC）。曲库/歌单/喜欢列表永不广播。浮窗冷启动 emit `mini:sync-request` → 主窗回发一次当前快照，之后走增量。
4. **指令转发（浮窗→主窗）**：按钮只 `emitTo('main','playback:cmd', 'toggle'|'next'|'prev'|'fav'|'cycleMode')`；主窗统一 listen 后调 store 现有方法，toggleFav 所需对象由主窗从 currentId 自行解析。**浮窗直接调本窗 store 的 toggle 是错的**——engine 的 hasSource() 在浮窗恒 false，会误走 startTrack 重载当前曲并重复记录最近播放。
5. **持久化归主窗（硬约束）**：快照三写点（restore / writeSnapshot / flushSnapshot）只在主窗可达；hydrated 在浮窗恒 false 作第二道保险（writeSnapshot 入口直接短路）。浮窗位置不进快照，单独存（tauri-plugin-window-state，或 listen `tauri://move` 存 appData JSON）。
6. **退出语义**：默认浮窗随主窗关闭销毁；若配托盘常驻则「关主窗=隐藏、真正退出走托盘菜单」（与 §待拍板 #4 联动）。

## 方案 B+C 骨架（建议先做）

- **C（SMTC，纯前端零 Rust）**：engine.ts 换曲/播放态变化处写 `navigator.mediaSession`——metadata（title/artist/album，artwork 用 `_1c` 方形封面；artwork 走 hdslb 外链还是经回环代理，需实测 CSP 对 mediaSession 资源的适用性）+ playbackState + setActionHandler('play'/'pause'/'previoustrack'/'nexttrack'/'seekto')，handler 包 try/catch（旧 WebView2 可能缺某 action）。handler 闭包在主窗上下文，调用方唯一，无双写问题。
- **B（托盘，Rust 为主）**：新建 src-tauri/src/tray.rs——TrayIconBuilder + 菜单（播放/暂停、上一首、下一首、喜欢 CheckMenuItem、显示主窗、退出）；on_menu_event 按 id `emitTo("main","playback:cmd",id)`；主窗前端 useEffect listen 后按 id 调 store 方法（指令全部在主窗执行，持久化写者仍唯一）。红心态：主窗换曲/toggleFav 后经轻量 Rust 命令 set_checked。可选进阶：canvas 缩封面换托盘图标（见 #9）。设置页加「启用托盘」开关（默认开）。生命周期：应用退出销毁托盘。

## 待拍板

1. 浮窗入口：主窗标题栏小按钮 / 设置页开关 / 快捷键唤起？是否要「最小化到托盘时自动弹浮窗」联动？
2. 浮窗首版边界：六键极简（播放 / 上下曲 / 红心 / 模式）还是加音量与进度条（多一组镜像字段与节流）？
3. macOS：接受浮窗点击抢焦点（无 NOACTIVATE 等价物），还是浮窗首版只发 Windows？
4. 托盘是否默认启用；关主窗=退出还是隐藏到托盘继续播放？（后者常驻更显眼，合规取向自行权衡）
5. 媒体键现状 10 分钟实测（当前版本按播放/暂停/下一首媒体键是否已生效、是否被其他播放器抢占）——决定方案 C 的起点。

## 时效声明

结论基于 Tauri 2.x（wry 0.55 / tao 0.35 时代）核验；ACL 细节、白闪行为随 Tauri 与 WebView2 Runtime 版本演进可能变化；SMTC 按钮集合为 Win10 10240 起的稳定 API。复评触发点：Tauri 大版本升级或 WebView2 Runtime 行为变化。
