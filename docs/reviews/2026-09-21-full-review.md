# bMuisc 全量代码审查（2026-09-21）

> 历史记录：下述问题已进入后续修复及复审，当前结论与验证限制见 [R1–R3 修复验收](2026-09-21-r123-verified.md)。

结论：确认 13 项问题，4 项 P1 / high、9 项 P2 / medium。优先处理进度丢失、损坏快照后的保存失效、切歌竞态和失败音源重试。此次仅审查，没有修改业务代码。

## 范围与方法

- 基线：`da8d7b6d68f4cb924225df45561c6d531c9d69c9` 加当前工作区，包括未提交及新增文件。下面区分原有问题与未提交改动引入的问题。
- 使用 Open Code Review 的委派模式：`ocr scan --preview` 获取完整文件清单，`ocr delegate preview` 识别工作区差异，`ocr delegate rule` 解析全部目标文件的审查规则；实际语义审查与复核由当前助手完成，未调用 OCR 外部 LLM 扫描。
- 一个审查执行者，未启动额外审查子代理，未超过 10 个审查进程约定。
- OCR 全量清单：98 个条目，37 个可审查文件，61 个排除条目；选中范围 `total_files=37`、`reviewed_files=37`、`skipped_files=0`、`coverage_rate=100%`。这是静态审查覆盖率，不是测试覆盖率。
- 排除范围为图片 / 图标资产、依赖锁文件、Markdown 文档和本机配置；README、规划和 AGENTS 作为业务背景阅读。OCR 读取 Git 全局 ignore 时出现权限警告，污染的是排除范围内的本机配置路径；已用仓库文件清单核对业务源码覆盖。
- 复现脚本在临时目录运行，使用独立内存存储和媒体测试替身；Rust 代理验证在仅监听回环的测试服务上执行，没有访问真实 B 站媒体或用户播放记录。

## P1 / high

### 1. 恢复后未播放就退出，会把上次进度覆盖为 0

- 位置：[src/store.ts:702](E:/code/bMuisc/src/store.ts:702)，关联快照写入第 76 行。
- 来源：原有问题；新增页面切换即时保存使触发入口更多。类别：bug。
- 触发：保存 125 秒的播放进度，重启后不播放，切换“我的喜欢”、调整音量或直接关窗，再次启动。
- 原因：恢复只设置 `savedSeek`，`position` 仍为初始 0；保存写的是 `position`，不是尚未消费的恢复进度。
- 复现结果：内存 `savedSeek=125`，导航触发的新快照 `position=0`。下一次启动从头播放。
- 建议：恢复时同步展示进度与待定位进度，或者保存时保留尚未消费的有效恢复进度；增加“连续两次启动且中间不播放”的回归。

### 2. 损坏快照会让后续新增音乐永久无法保存

- 位置：[src/store.ts:711](E:/code/bMuisc/src/store.ts:711)，关联第 65–68 行的 `hydrated` 门控。
- 来源：未提交改动新增。类别：bug。
- 触发：v3 快照无法解析，应用仍允许重新添加音乐、创建歌单和收藏。
- 原因：异常路径让 `hydrated` 永久保持 false，所有写入静默返回；也没有提示、恢复或重建入口。存在可用 v2 / v1 时，坏 v3 仍会优先被读取。
- 复现结果：内存已新增一首音乐，强制保存后磁盘模拟值仍是 `{broken`；重启会丢掉用户以为已保存的新数据。
- 建议：备份坏档，明确提示并提供恢复 / 重建流程；恢复有效旧版本后再启用写入。不要直接静默覆盖原始坏档，也不要允许保存失败却显示成功。

### 3. 旧曲目的结束事件会跳过刚选中的新曲目

- 位置：[src/engine.ts:80](E:/code/bMuisc/src/engine.ts:80)，关联第 54–78 行和 `loadTrack` 常规解析路径。
- 来源：原有问题。类别：bug。
- 触发：A 即将结束时点播 B，B 的解析尚未完成，A 发出 `ended`。
- 原因：store 已把当前项切为 B，但引擎仍保留 A 的媒体源。多数事件只检查 `el === audio`，没有检查当前操作编号；旧 `ended` 根据 B 的队列位置继续推进。
- 复现结果：直接运行 store 与 engine 的现有代码，选择 B 后注入 A 的结束事件，`currentId` 变为 C；旧 `timeupdate` 也能把 A 的进度写到 B。
- 建议：切换加载会话时停止或隔离旧媒体事件，确保进度、暂停、结束等事件均属于当前曲目与操作编号。

### 4. 失败曲目重试复用坏音源，无法重新解析恢复

- 位置：[src/engine.ts:148](E:/code/bMuisc/src/engine.ts:148)。
- 来源：原有问题。类别：bug。
- 触发：媒体节点失败或地址过期产生媒体错误后，再次点播同一队列项。
- 原因：同曲快捷分支仅检查标识和 `audio.src`，即使媒体已有错误仍只 seek + play；该分支还在统一 try/catch 外。store 吞掉 rejection，假定引擎已经上报错误。
- 复现结果：两次点播仅调用一次 `resolveStreams`；重试拒绝后最后状态仍为 `loading=true, error=null`。
- 建议：快捷复用必须要求可继续播放的媒体状态；出错时清理源并有限重新解析，快捷与常规分支统一处理失败和 loading 状态。

## P2 / medium

### 5. 解析期间暂停会被解析完成后的自动播放覆盖

- 位置：[src/engine.ts:190](E:/code/bMuisc/src/engine.ts:190)，关联 `togglePlay`。
- 来源：原有问题。类别：bug。
- 触发：A 正在播放时切到 B，在 B 的解析阶段点击暂停。
- 复现结果：旧媒体确实暂停，但 B 返回后无条件执行 `audio.play()`，重新开始播放。
- 建议：单独记录用户期望的播放 / 暂停状态，异步完成时遵循最新意图；不要仅依赖旧媒体元素的 paused 值。

### 6. 预取媒体加载失败后没有回退常规解析

- 位置：[src/engine.ts:157](E:/code/bMuisc/src/engine.ts:157)。
- 来源：原有问题。类别：bug。
- 触发：B 的预解析成功并建立了备用元素，但预加载网络失败；TTL 内切换到 B。
- 原因：预取命中不检查备用元素的媒体错误，先释放 A，再播放出错的 B；快捷路径失败不会落入常规解析。
- 复现结果：主播放与预解析共两次 `resolveStreams`，切到损坏的预取元素后没有第三次解析，也没有统一结束加载状态。
- 建议：命中前检查预取健康状态；播放失败时清理预取并有限回退常规加载，保证失败反馈可见。

### 7. 清空队列没有真正释放预取元素

- 位置：[src/engine.ts:264](E:/code/bMuisc/src/engine.ts:264)。
- 来源：原有问题。类别：performance。
- 触发：下一首正在预加载时清空队列或停止到队尾。
- 原因：`spare` 直接置空，只对当前 audio 执行 `clearElement`。丢引用不等于停止媒体加载，尤其备用元素可能关联 WebAudio 节点。
- 复现结果：清空后当前元素无源，原备用元素仍保留 `/audio/s2` 的 src；是否继续拉流以及持续时间需 WebView 实测。
- 建议：先 pause / 移除 src / load 清理所有备用媒体，再清空引用，并核验媒体节点连接和网络资源释放。

### 8. 代理遇到 5xx 不会尝试正常的备用 CDN

- 位置：[src-tauri/src/proxy.rs:106](E:/code/bMuisc/src-tauri/src/proxy.rs:106)。
- 来源：原有问题，当前只调整了 416 的处理。类别：bug。
- 触发：首个候选返回 500 / 502 / 503，后续候选可正常提供音频。
- 原因：仅网络请求错误和 4xx 会 continue；5xx 直接被转发给播放器。
- 复现结果：复制原始代理源码进行本机 HTTP 测试，首个节点返回 503、备用节点可返回 200，但备用命中次数为 0，下游收到 503。
- 建议：将可重试的 5xx 纳入候选轮替，并在全部候选失败后统一返回明确错误。

### 9. 合法的后缀 Range 被丢弃

- 位置：[src-tauri/src/proxy.rs:65](E:/code/bMuisc/src-tauri/src/proxy.rs:65)。
- 来源：原有问题。类别：bug。
- 触发：客户端请求 `Range: bytes=-1024` 读取媒体尾部。
- 原因：先解析横线前的起点数字，后缀请求的起点为空，直接返回 None；上游收到的请求不再包含 Range。
- 复现结果：对原函数执行测试，`normalize_range(Some("bytes=-1024")) == None`。这违反了此代理承诺的后缀 Range 透传语义，可能将尾部读取变成整段传输；未声称在所有平台都会触发播放失败。
- 建议：区分开放式、有界和后缀 Range，仅对开放式请求分块，其余合法形式保持语义。

### 10. 重启后音乐库顺序被播放队列改写

- 位置：[src/store.ts:656](E:/code/bMuisc/src/store.ts:656)。
- 来源：未提交改动新增。类别：bug。
- 触发：音乐库为 A、B、C，播放队列只含 C，保存并重启。
- 原因：恢复无条件按队列先重建 `libOrder`，再追加库中其他内容，完全没有读取已保存的 `data.libOrder`；v1 迁移逻辑同时用于 v3。
- 复现结果：保存顺序 A、B、C，恢复后变为 C、A、B，影响列表展示及“播放全部”的顺序。
- 建议：v2 / v3 按保存顺序校验恢复，补齐缺失项；只有无曲目库的旧快照才从队列迁移。

### 11. 窄窗口隐藏了唯一的音乐库 / 歌单导航

- 位置：[src/index.css:774](E:/code/bMuisc/src/index.css:774)。
- 来源：未提交改动新增。类别：bug。
- 触发：把窗口缩到 880–1020 CSS 像素宽，仍在配置允许的尺寸范围内。
- 代码证据：媒体查询把 `.sidebar` 设为 `display:none`；App 与底部栏只有队列开关、正在播放开关，没有替代的导航抽屉入口。
- 影响：无法通过常驻导航切换全部音乐、喜欢及其他歌单，也无法使用侧栏创建空歌单。
- 建议：增加折叠导航入口或保留紧凑导航；静态路径已核对，尚未做本轮窗口实机视觉验证。

### 12. 重新解析已有曲目不会更新库里的元信息

- 位置：[src/store.ts:227](E:/code/bMuisc/src/store.ts:227)。
- 来源：未提交改动新增。类别：bug。
- 触发：已收录 A，再解析并添加标题 / 封面已变化的同一曲目，例如选择立即播放或添加到另一歌单。
- 原因：`nextLib[k]` 虽然被赋值，但只有出现全新 key 才把 `changed` 设为 true；全部为已有曲目时新的 lib 从未提交。
- 复现结果：A 再次添加的标题为 Updated，库中标题仍为 A。新队列项和音乐库还可能显示不同元信息。
- 建议：把元信息变更与顺序新增分开处理，有实际元信息变化时同步提交并持久化。

### 13. 歌曲行的收藏、更多及排序操作无法纯键盘访问

- 位置：[src/index.css:702](E:/code/bMuisc/src/index.css:702)。
- 来源：原有样式问题；新增音乐库和歌单继续复用，影响范围扩大。类别：bug。
- 触发：不移动鼠标，使用 Tab 聚焦歌曲标题，再尝试进入红心、更多、移除或排序按钮。
- 代码证据：`.row-actions` 默认为 `display:none`，唯一显示条件是 `.queue-row:hover`；隐藏元素不参与 Tab 焦点序列，也没有 `:focus-within` 或其他键盘入口。
- 建议：行获得焦点时同样显示操作，或保留可聚焦的常驻更多按钮；同时补充键盘可见焦点样式。

## 验证结果与限制

| 验证 | 结果 |
| --- | --- |
| `npm run build` | 通过：TypeScript + Vite |
| `cargo test --manifest-path src-tauri/Cargo.toml --test live_parse extract_bvid_from_url --offline` | 通过，1 个离线输入提取测试，联网用例未运行 |
| 隔离 TypeScript / Zustand / engine 复现脚本 | 10 个探针通过，分别确认上文 9 项问题；其中旧事件污染与跳过曲目是同一问题的两个探针 |
| 原始 Rust 代理源码的隔离测试 | 2 个探针通过，确认 5xx 不轮替及后缀 Range 丢失 |
| 界面导航与键盘入口 | 静态 JSX / CSS 交叉核对，未冒充实机 UI 验证 |

“探针通过”表示复现到了报告的问题，不表示功能验收通过。TypeScript 媒体探针使用可控 Audio 测试替身，验证逻辑与事件顺序；并非真实解码 / CDN 播放。Rust 测试临时项目使用离线缓存中满足原清单版本范围的依赖，不是应用发布二进制。

临时复现材料位于 `D:/MyConfiguration/TCLDUSER/AppData/Local/Temp/bmuisc-cr-20260921/`，包括 OCR 清单、规则、`repro.cjs`、`repro-results.json` 和 `proxy-repro/`。临时目录可能被系统清理。

尚未执行：真实 B 站联网播放、长时间播放 / 内存测量、Windows 窗口交互回归、macOS / Linux 实机、安装包验证。随机播放历史等规划与实现差异需另行核对产品验收，不与以上可确认缺陷混计。

## 文件覆盖清单

以下 37 个文件均已审阅，未发现问题的文件不等于经过全部运行场景验证。

```text
.github/workflows/release.yml
.gitignore
demo/index.html
demo/server.mjs
index.html
package.json
scripts/gen-icon.ps1
src-tauri/Cargo.toml
src-tauri/build.rs
src-tauri/capabilities/default.json
src-tauri/src/bilibili.rs
src-tauri/src/commands.rs
src-tauri/src/lib.rs
src-tauri/src/main.rs
src-tauri/src/proxy.rs
src-tauri/tauri.conf.json
src-tauri/tests/live_parse.rs
src/App.tsx
src/api.ts
src/components/AddBar.tsx
src/components/NowPlaying.tsx
src/components/ParseModal.tsx
src/components/PlayerBar.tsx
src/components/QueuePanel.tsx
src/components/WaveViz.tsx
src/components/icons.tsx
src/engine.ts
src/index.css
src/main.tsx
src/store.ts
src/util.ts
tsconfig.json
vite.config.ts
src/components/PlaylistPicker.tsx
src/components/Sidebar.tsx
src/components/Toast.tsx
src/components/TrackView.tsx
```
