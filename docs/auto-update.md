# 自动更新机制

2026-09-23 实现。方案：`tauri-plugin-updater` v2 + GitHub Releases `latest.json` 清单 + minisign 签名校验。更新提示 → 用户手动确认 → 下载（带进度）→ 安装重启。

## 组成

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 更新插件 | `src-tauri`（`tauri-plugin-updater = "2"`，按桌面 target 划分） | `#[cfg(desktop)]` 在 setup 里注册 |
| 公钥 | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` | minisign 公钥，随应用发布 |
| 检查端点 | `plugins.updater.endpoints` | `https://github.com/roy2651/bMuisc/releases/latest/download/latest.json`（GitHub 302 到最新 Release 资产，只有非 2XX 才会尝试下一个端点） |
| 更新产物 | `bundle.createUpdaterArtifacts = true` | 构建时产出安装包 + `.sig` 签名文件 |
| CI 签名 | `.github/workflows/release.yml` | tauri-action 检测到 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 两个 Secrets 后自动签名并生成 `latest.json`（含 windows-x86_64 / darwin-aarch64 / darwin-x86_64 条目）挂在 Release 上 |
| 前端 | `src/updater.ts` + `UpdateModal` / `SettingsModal` | 平台 gating、弹窗、设置入口 |

## 密钥管理（关键）

- 私钥：`D:\MyConfiguration\TCLDUSER\.tauri\bmuisc-updater.key`（**不在仓库、绝不提交**）；已存 GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`，密码存 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`；另有离线备份。
- **私钥或密码丢失 = 已装用户永远收不到可用更新**（签名校验不过），只能重新下载安装包手动覆盖安装。备份务必保留。
- `latest.json` 每次发版由 CI 自动生成覆盖，不要手工编辑。

## 客户端 gating（src/updater.ts）

- 仅 **Windows + 生产构建** 开启检查：`import.meta.env.PROD && /Windows/i.test(navigator.userAgent)`。
- macOS 暂不开放：安装包未公证，更新替换后的新包会被 Gatekeeper 拦截（等公证方案落地再放开，参考 cc-switch 的做法：公证只需 $99/年 开发者账号）。
- 开发模式不检查：`check()` 会真连 `latest.json`，本地版本低于线上时会弹出更新甚至触发安装。

## Windows 更新行为（源码级验证 2026-09-23）

点击「立即更新」后的完整链路：

1. 前端 `update.downloadAndInstall()` 下载安装包（进度事件：Started / Progress / Finished）。
2. 插件启动 NSIS 安装器，参数 `/P /UPDATE /R`（passive 模式）：`/P` 被动进度条、`/UPDATE` 更新模式、`/R` 装完重启。
   - 依据：plugins-workspace `updater/src/config.rs`——`nsis_args()` passive 给 `/P`，`nsis_restart_after_install_args()` 给 `/R`（`restart_after_install` 默认 `true`，updater.rs）。
   - NSIS 模板 `.onInstSuccess`：passive / silent 下仅当命令行有 `/R` 才 `RunAsUser` 重启应用。
3. 安装期间应用自动退出；安装完成后**自动以新版本重启**（沿用原启动参数）。
4. 全程用户只需点一次「立即更新」。

## 交互

- 启动后 6 秒静默检查一次（避开启动期的解析 / 代理请求），失败静默不打扰。
- 发现新版本 → 弹窗（版本号 + release notes + 立即更新 / 稍后再说）。
- 下载 / 安装阶段弹窗禁止关闭（安装时应用即将退出，防止误以为更新失败）。
- 顶栏齿轮 → 设置弹窗：版本信息、启动检查开关（`localStorage` `bmuisc.autoupdate`）、手动检查。
- 检查与下载请求都在 Rust 侧进行，不受前端 CSP 约束。

## 端到端验证

- **✅ 2026-09-23 实机验收通过**：v0.3.0 客户端（Windows 实机）启动后收到 v0.3.1 提示，手动确认 → 下载 → 安装 → 应用自动重启至 v0.3.1，整链路（检查 → 提示 → minisign 签名校验 → NSIS 静默安装 → 自动重启）走通。
- 验收过程：v0.3.0 = 首个带更新器的签名版本（发布它时 `latest.json` 里它自己就是最新，不会有人收到提示）；发布 v0.3.1 后 v0.3.0 客户端完成升级。
- v0.3.0 之前的版本没有更新器，收不到提示，需手动下载 v0.3.0 安装包覆盖安装一次（NSIS 覆盖安装不影响 `%LOCALAPPDATA%` 用户数据）。
- 两个 tag 必须先后发（等上一轮 CI 结束再打下一个）：两次运行都写 latest.json，并发时最后完成的赢，若 v0.3.0 的构建晚于 v0.3.1 结束，清单会反向指向旧版。

## 风险

- 私钥 / 密码丢失 → 更新通道永久失效（见上）。
- `latest.json` 是唯一清单：版本比较、下载地址、签名都在里面，依赖 CI 正确生成；若某次发版 Secrets 缺失，构建会失败（签名环境变量缺失时 tauri-action 无法产签名），不会静默发未签名更新。
- 语义化版本：更新只按 semver 向上比较，版本号务必每次发版递增。`latest.json` 的版本号取自 `tauri.conf.json`（**不是 tag**），CI 已加守门步骤（tag 与 tauri.conf.json 版本不一致直接失败）。
- latest.json 三 job 并发合并的小概率竞态（tauri-action 源码确认：读-改-写无锁，两个 macOS matrix job 几秒内同时完成时可能丢平台条目；重试机制覆盖大多数交错，风险接受）。若出现"发了版但收不到更新"，先检查 Release 里 latest.json 的内容。

## 本地打包注意

`createUpdaterArtifacts = true` 后，本地 `npm run app:build`（发版打包）需要签名私钥，否则构建在签名阶段报错退出（已有公钥找不到私钥）。两种方式：

```powershell
# 方式一：提供真实密钥（本机密钥在 D:\MyConfiguration\TCLDUSER\.tauri\）
$env:TAURI_SIGNING_PRIVATE_KEY = 'D:\MyConfiguration\TCLDUSER\.tauri\bmuisc-updater.key'  # 文件路径即可
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '<密码>'
npm run app:build

# 方式二：仅测试安装包，跳过签名（tauri-cli >= 2.9.5）
npx @tauri-apps/cli build --no-sign
```

开发运行（`npm run app:dev`）不受影响——签名只发生在 build 的打包阶段。发版一律走 CI（GitHub Actions），本地构建仅用于验证。
