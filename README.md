<p align="center">
  <img src="src-tauri/icons/icon.png" width="96" height="96" alt="bMuisc Logo" />
</p>

<h1 align="center">bMuisc</h1>

<p align="center">把 B 站的音乐，放进你的桌面播放器。</p>
<p align="center">独立音频播放 · 本地音乐库与歌单 · B 站收藏夹导入与推送</p>

<p align="center">
  <a href="https://github.com/roy2651/bMuisc/releases/latest"><strong>下载最新版</strong></a> ·
  <a href="#下载安装">安装说明</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="docs/project-plan.md">产品规划</a>
</p>

![bMuisc 正在播放页：封面、曲目信息、播放队列与底部控制栏](docs/images/now-playing.jpg)

<p align="center"><sub>v0.4.0 前端界面预览；曲目与账号为演示数据，封面使用项目 Logo。桌面窗口外观随平台变化。</sub></p>

## 核心功能

- **听音频优先**：粘贴 B 站视频链接或 BV 号，播放独立音轨；支持多分 P、合集选择，随时打开原视频页面。
- **连续播放**：四种播放模式、队列管理、下一首预取，以及进度、音量和静音控制。
- **整理你的音乐**：全部音乐、我的喜欢、自建歌单与最近播放；保存音乐不打断当前播放。
- **连接 B 站收藏夹**：扫码登录后导入收藏夹，也能把本地歌单推送回 B 站；增量追加，不删除远端已有内容。
- **记住上次听到哪里**：本地保存音乐库、歌单、队列及进度；重启恢复记录，由你决定何时继续播放。
- **桌面体验**：深色界面、托盘与系统媒体控制；Windows 支持自动检查更新，确认后下载安装。

<details>
<summary><strong>更多界面：音乐库与收藏夹导入</strong></summary>

### 音乐库

在音乐库、喜欢与歌单之间切换，当前播放和队列保持独立。

![bMuisc 音乐库：侧栏分类、曲目列表与独立播放队列](docs/images/library.jpg)

### 从 B 站导入

选择收藏夹建立本地歌单；已关联的收藏夹再次导入时增量更新。

![bMuisc 收藏夹导入：选择收藏夹并查看已有歌单关联](docs/images/favorites-import.jpg)

</details>

## 下载安装

前往 **[GitHub Releases](https://github.com/roy2651/bMuisc/releases/latest)** 下载对应平台的安装包，实际可用资产以发布页面为准。

| 平台 | 安装包 | 说明 |
| --- | --- | --- |
| Windows 10+ | `*-x64-setup.exe` | 运行安装，需要 WebView2 |
| macOS · Apple Silicon | `*-aarch64.dmg` | 适用于 M 系列芯片 |
| macOS · Intel | `*-x64.dmg` | 适用于 Intel 芯片 |

Windows 是首要验证平台；macOS Apple Silicon 基础音频流程已有历史实机记录。Linux 尚待适配验证，移动端暂未提供。当前版本的验证范围见[项目进度与验证记录](docs/project-status.md)。

### macOS 首次打开

将应用拖入「应用程序」。当前安装包尚未完成 Apple 公证，首次打开可能被系统拦截：

1. 尝试打开 bMuisc 一次。
2. 进入 **系统设置 → 隐私与安全性**，找到被阻止的应用，点击 **仍要打开**。
3. 若提示「应用已损坏」，确认安装包来自本项目 Releases，再在终端执行：

   ```bash
   xattr -dr com.apple.quarantine /Applications/bMuisc.app
   ```

macOS 自动更新将在公证完成后开放；目前请从 Releases 下载新版本。

## 快速开始

1. **添加音乐**：在顶栏粘贴视频链接或 BV 号，点击「解析」。
2. **选择与保存**：选择分 P 或合集条目，保存到音乐库、喜欢或歌单；需要直接开播时勾选「添加后立即播放」。
3. **开始听歌**：在列表中点播；点击底栏封面进入正在播放页，通过右侧队列管理接下来要听的内容。
4. **导入收藏夹（可选）**：扫码登录 B 站，从侧栏「从B站导入收藏夹」入口选择收藏夹；歌单菜单中可「推送到B站」。

普通公开内容的音频播放无需登录。登录凭证保存在系统安全存储中；本地记录保存曲目元信息和播放状态，不保存媒体文件。

## 功能边界与后续计划

当前版本为 **v0.4.0**，以音频播放为主。应用内音视频切换、Linux 适配及 macOS 公证仍在后续计划中；不提供离线下载、媒体转存或会员内容解锁。

收藏夹导入与推送均为用户主动操作、增量追加，不是自动镜像同步。完整交互约定和后续阶段见[项目规划](docs/project-plan.md)，实施及验收记录见[项目进度](docs/project-status.md)。

## 本地开发

技术栈：**Tauri 2 · React 19 · TypeScript · Vite · Zustand · Rust**。

准备 Node.js 18+、Rust 1.88+ 及对应平台的 [Tauri 开发依赖](https://v2.tauri.app/start/prerequisites/)。Windows 需要 WebView2。

```bash
npm install
npm run app:dev   # 启动桌面开发环境
npm run build     # TypeScript 检查与前端生产构建
npm run app:build # 构建桌面安装包
```

`npm run dev` 只启动前端预览，不能替代 Tauri 原生解析与媒体代理链路。

| 目录 | 内容 |
| --- | --- |
| `src/` | 界面组件、播放引擎与状态管理 |
| `src-tauri/` | B 站解析、本地媒体代理、原生命令与打包配置 |
| `src-tauri/tests/` | 输入提取与依赖外网的解析冒烟测试 |
| `docs/` | 产品规划、技术调研、验证记录与界面截图 |
| `scripts/` | 应用图标生成脚本 |
| `demo/` | M0 阶段参考实现，非当前应用入口 |

## 文档

- [产品规划与验收矩阵](docs/project-plan.md)
- [项目进度与历史验证记录](docs/project-status.md)
- [媒体接口与代理实测](docs/m0-findings.md)
- [账号登录与收藏夹导入 / 推送](docs/login-fav-research.md)
- [自动更新机制](docs/auto-update.md)
- [平台扩展可行性](docs/platform-feasibility.md)
- [迷你浮窗评估](docs/mini-window-eval.md)

## 说明

本项目为独立项目，与 B 站无官方关联；内容权利归原作者及相关权利人所有。仅处理用户有权访问的内容，不绕过登录、付费或内容保护机制。B 站接口及媒体地址策略可能变化，访问能力以平台实际返回为准。
