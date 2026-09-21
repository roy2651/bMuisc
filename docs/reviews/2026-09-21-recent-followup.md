# 最近播放修复复审（2026-09-21）

> 历史记录：下述遗漏已修复，当前结论见 [最终验收](2026-09-21-recent-verified.md)。

结论：上轮两个原始复现路径均通过，但新会话识别仍遗漏同曲目的主动点播，保留 1 项 P2。本轮不提交，不修改业务代码。

## 范围与已通过项

- 基线 `5501d62`，目标为当前未提交的最近播放功能。执行 OCR delegate preview / rule，语义复核由当前助手完成，未调用 OCR 外部 LLM。
- OCR 源码范围为 store.ts、Sidebar.tsx、TrackView.tsx、icons.tsx：`total_files=4`、`reviewed_files=4`、`skipped_files=0`、`coverage_rate=100%`。相对上轮仅 store.ts 与规划文档变化，其余源码核对哈希后沿用审查结果；另检查 engine.ts 事件语义。1 个执行者、0 个子代理。
- “清空队列后重新点播同曲”已能再次记入；“play → waiting → error、没有 playing”不再进入内存或持久化历史。
- 11 项正向隔离检查通过：原 7 项去重 / 持久化 / 隔离 / 迁移 / 上限 / 队列回归，加上述 2 项修复、失败重试保留移除、解析中暂停不记入且真正恢复后记入。
- `npm run build` 通过，55 个模块，JS 292.79 kB；`git diff --check` 通过。交付前 6 个审查输入文件哈希未变化。

## P2：队列主动重新点播当前曲目仍被当作同会话重试

- 位置：`src/store.ts:319–320`。
- 复现：播放 A 至 100 秒 → 从最近播放移除 A → 暂停 → 点击队列中的 A 行重新播放。
- 实际：`playAt` 调用 startTrack，从 0 秒重新开播并收到 playing；但 recent 仍为空，快照也没有 A。当前项与目标项的 key 相同，因此旧的 recentRecordedFor 未清除。
- 这是新点播行为，和主播放按钮继续播放或错误重试不同；只比较曲目 key 无法区分用户意图。清空路径虽然已修好，原问题尚未完整覆盖各点播入口。
- 建议：让调用方明确传入新点播 / 续播 / 重试意图，或使用独立播放会话身份。新点播允许重新记入，同一会话的暂停、缓冲恢复和失败重试继续保留用户移除。

## 补充验证边界

- 同源正在播放时调用 play() 不保证再次触发 playing。媒体替身按“已播放则不重复发 playing”建模时，从音乐库重新点播同一曲也会漏记；这项作为同源快捷路径的额外回归场景，尚未做 WebView 实机时序确认，不单独列为已确认缺陷。
- 所有探针运行实际 store / engine 与 Zustand，使用隔离媒体、API、localStorage；不代表真实 B 站播放或桌面 UI 已验收。
- 证据目录：`D:/MyConfiguration/TCLDUSER/AppData/Local/Temp/bmuisc-recent-followup-20260921/`，包含 verify.cjs、results.json 及 hashes.json。结果中的 BUG 探针是确认异常行为的断言，不能按脚本退出码将其理解为业务通过。
