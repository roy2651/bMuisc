# bMuisc 修复复审（2026-09-21）

> 历史记录：下述 R1–R3 已在后续复审中验证修复，当前结论见 [R1–R3 修复验收](2026-09-21-r123-verified.md)。

结论：大部分原问题已修复，但仍有 3 项确认问题（1 项 P1、2 项 P2），本轮不通过，不执行 commit。未修改业务代码。

## 范围与方法

- 对照上一轮 `2026-09-21-full-review.md` 的 13 项问题，检查当前工作区修复及相关回归。Git HEAD 为 `da8d7b6d68f4cb924225df45561c6d531c9d69c9`。
- 使用 Open Code Review 委派模式：`ocr delegate preview --format json` 选择文件，`ocr delegate rule --format json` 解析规则；语义审查和复现由当前助手执行，未调用 OCR 外部 LLM 扫描。
- OCR 选中 15 个源码文件，审查 15 个，跳过 0 个；这是静态阅读覆盖，不是测试覆盖。本轮不是重新全量扫描所有未改动文件。
- 覆盖 proxy.rs、App.tsx、engine.ts、store.ts、index.css，以及 AddBar、NowPlaying、ParseModal、PlayerBar、QueuePanel、icons、PlaylistPicker、Sidebar、Toast、TrackView。文档作为背景阅读；排除本机 `.claude/` 配置及审查记录。
- 使用 1 个主审查执行者、0 个子代理，没有超过 10 个审查进程上限。交付前核对 15 个源码文件的 SHA256，均与复审开始时一致。
- 前端探针直接转译当前 store/engine 源码，使用真实 Zustand、隔离 localStorage、可控 Audio/API 替身；Rust 探针复用当前 proxy.rs，在回环测试服务器验证。

## 尚未解决的问题

### R1 · P1：切歌解析失败后，播放按钮会恢复上一首，但界面显示新曲目

- 位置：`src/engine.ts:268–271`；关联 `src/store.ts:481–496`、`src/engine.ts:280–281`。
- 复现：播放 A → 暂停 A → 点播 B → B 的解析请求失败 → 点击底部播放按钮。
- 实际：store 的 `currentId` 仍为 B，媒体源仍是 A；`hasSource()` 只判断 src 非空，导致直接恢复 A。新增的 `report({ playing: true })` 又把 B 标成正在播放。
- 隔离探针输出：`currentId="B"`、`playing=true`、`actualSource="http://127.0.0.1:1234/audio/A"`。A 的进度与结束事件仍被 token 门控丢弃，后续进度和自动切歌也无法正常工作。
- 来源：旧源留存的问题仍在；本轮新增手动补报播放态把错误会话标为播放成功，并没有恢复曲目身份的一致性。
- 建议：播放前确认媒体源属于当前曲目及会话；失败后重试当前 B，或者若产品确实允许回退 A，则同时正确恢复 A 的身份和事件会话。不能仅补报 playing。

### R2 · P2：主播放按钮仍无法重试已经报错的媒体源

- 位置：`src/store.ts:487–496`；关联 `src/engine.ts:268`、`src/engine.ts:280–281`。
- 复现：A 加载后进入媒体错误状态，例如 `MEDIA_ERR_SRC_NOT_SUPPORTED`（代码 4，paused=true），然后点击底部播放按钮。
- 实际：错误元素仍有 src，`hasSource()` 返回 true，因此不会走已修复的 `loadTrack()` 重解析分支，而是对同一错误源再次调用 `audio.play()`；拒绝的 Promise 也没有被捕获。
- 隔离探针输出：解析次数始终为 1，收到未处理的播放拒绝。重新点击歌曲行可以触发第二次解析，所以此前第 4 项只修复了行点播入口。
- 来源：原问题的遗漏入口，不是此次新增缺陷。
- 建议：将媒体错误状态纳入源可用性判断，让主播放按钮进入当前曲目的有界重试流程，并保留有效进度；统一处理 play() 拒绝。

### R3 · P2：旧解析请求完成会清除新请求的 resolving 状态

- 位置：`src/engine.ts:212–215`；相同问题也存在于 `src/engine.ts:224–226` 的 catch 分支。
- 复现：播放 A → 连续请求 B、C（两者都在解析）→ 暂停 → 旧 B 请求完成，但 C 仍未完成 → 点击播放。
- 实际：B 在检查 `my !== token` 之前就把共享的 `resolving` 设为 false，导致播放按钮绕过“仅更新播放意图”的保护，恢复旧 A。探针确认 C 仍 pending 时 A 的 play 调用次数增加。
- 来源：本轮引入 resolving 全局标记时新增的竞态，与 R1 的“当前请求已经失败”不同；这里当前 C 请求仍在正常等待。
- 建议：成功及异常分支都先确认请求仍属于当前 token，再更新 resolving；或以当前解析 token 表示状态，避免旧会话修改新会话的标记。

## 上轮 13 项逐项结果

| 原编号 | 问题 | 本轮结果与依据 |
| --- | --- | --- |
| 1 | 恢复进度被覆盖为 0 | 原路径通过：恢复 125 秒后导航保存仍为 125 秒 |
| 2 | 坏快照导致后续保存失效 | 原路径通过：坏档备份、重新添加后保存成功；有效 v2 可回退恢复 |
| 3 | 旧媒体事件跳过新曲目 | 原路径通过：B 解析时 A 的 ended/timeupdate 不再推进或污染 B；另见 R1/R3 的控制入口问题 |
| 4 | 失败音源重试仍复用坏源 | 部分修复：行点播会重解析；主播放按钮仍有 R2 |
| 5 | 解析中暂停被覆盖 | 原路径通过：单次切歌解析完成后保持暂停；并发解析另有 R3 |
| 6 | 预取错误没有回退 | 原路径通过：错误预取元素被弃用，重新解析后播放 |
| 7 | 清空不释放预取元素 | 原路径通过：清空后 spare 的 src 为空 |
| 8 | 代理 5xx 不切换候选 | 回环测试通过：首节点 503，备用节点收到请求并返回 200 |
| 9 | 后缀 Range 丢失 | 回环测试通过：`bytes=-1024` 保留到上游 |
| 10 | 恢复时队列覆盖音乐库顺序 | 原路径通过：仅 C 在队列，恢复后库顺序仍为 A、B、C |
| 11 | 窄窗隐藏唯一导航 | 静态修复已核对：横向导航保留入口，队列开启时预留空间；未做桌面实机视觉验收 |
| 12 | 已有曲目元数据刷新丢失 | 原路径通过：重复添加同 key 后 title 正确更新 |
| 13 | 行操作只能鼠标访问 | 静态修复已核对：focus-within 显示操作按钮；未做桌面实机键盘验收 |

## 验证与限制

- `npm run build`：通过 TypeScript 检查及 Vite 构建。
- `cargo test --manifest-path src-tauri/Cargo.toml --test live_parse extract_bvid_from_url --offline`：1 项通过。
- 独立代理测试：2 项通过（503 候选回退、后缀 Range）。
- 前端隔离探针：10 个原修复检查满足断言；另 3 个探针成功复现 R1/R2/R3。脚本退出成功代表断言符合预期，不代表没有缺陷。
- `git diff --check`：通过；Git 有换行符及全局 ignore 权限警告，不影响本轮源码比对。
- 未执行真实 B 站媒体播放、Tauri 桌面 UI、Windows/macOS 跨平台实机验收；Audio/API 替身不能证明 WebView 的所有媒体行为。
- 复现脚本、源码快照和结果位于本机临时目录 `D:/MyConfiguration/TCLDUSER/AppData/Local/Temp/bmuisc-cr-followup-20260921/`，其中 `verify.cjs` 为前端探针、`results.json` 为结果、`proxy-repro/` 为代理测试工程。
- 按 AGENTS.md 的授权，只有 OCR 无待解决有效问题且必要验证通过才自动提交。本轮有上述 3 项问题，因此未暂存、未提交、未推送。
