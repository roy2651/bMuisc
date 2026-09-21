# 最近播放功能审查（2026-09-21）

> 历史记录：原始问题及同曲目主动点播遗漏均已修复，当前结论见 [最终验收](2026-09-21-recent-verified.md)；中间过程见 [修复复审](2026-09-21-recent-followup.md)。

结论：确认 2 项 P2 / medium 问题，本轮不通过，未修改业务代码、未提交。

## 范围与方法

- 基线：`5501d62` 加当前未提交的最近播放功能。另核对相对上轮 `3984fa0` 的版本提交，四处版本一致更新为 0.2.1。
- 执行 OCR 委派模式的 workspace preview（排除本机 `.claude/`）及规则解析，由当前助手审查；未调用 OCR 外部 LLM 扫描。
- OCR 选中 store.ts、Sidebar.tsx、TrackView.tsx、icons.tsx：`total_files=4`、`reviewed_files=4`、`skipped_files=0`、`coverage_rate=100%`。项目规划另作需求背景核对。1 个执行者，0 个子代理。
- 使用实际 store / engine 源码与 Zustand，隔离 localStorage、Audio 和 API 替身验证；未运行真实 B 站媒体或桌面 UI。审查末尾核对 5 个输入文件哈希，未发生变化。

## 1. P2：以曲目 key 代替播放会话，导致新一次播放漏记

- 位置：`src/store.ts:382–384`，关联模块级 `recentRecordedFor`。
- 复现：播放 A → 从最近播放移除 A → 清空队列 → 从音乐库重新点播 A。
- 实际：新的 A 已正常播放，recent 仍为空，快照也不记录它。`recentRecordedFor` 在清空或新播放行为时不重置，只有另一首成功记入后才变化。
- 影响：同一应用运行期间，清空再播放、单曲队列重新开始等新会话会继续继承旧会话的移除状态。
- 建议：明确区分暂停 / 缓冲恢复、失败重试与新的用户点播会话，用会话标识及移除状态控制记录；新会话应允许重新入列，同时保留“同一会话恢复不撤销用户移除”的现有保护。

## 2. P2：请求播放就写历史，尚未实际播放的失败曲目也会记入

- 位置：`src/store.ts:852`，关联 `src/engine.ts` 的 play / playing 事件处理。
- 复现：选择 B，媒体触发 play → waiting，在任何 playing 事件之前网络失败。
- 实际：engine 的 play 事件已上报 `playing: true`，store 随即记入并立即保存 B。后续错误分支跳过快照写入，也不会撤销错误记录。
- 探针输出：实际 playing 事件次数为 0，内存与持久化 recent 均为 `["B:66"]`。
- 影响：“最近播放”混入从未开播的条目，并可能挤掉 50 条上限内的有效历史，与界面“播过的歌曲”及文档“开播即记”不符。
- 建议：使用当前会话首次实际 playing 的独立信号记录历史，不将用于播放按钮状态的 `playing: true` 等同于真正开播。

## 验证结果

- `npm run build`：TypeScript 与 Vite 通过，55 个模块，JS 292.70 kB。
- `git diff --check`：通过，仅有 CRLF 提示。
- 7 项正向检查通过：去重排序并落盘、移除不影响库 / 喜欢 / 歌单 / 队列、暂停恢复不撤销移除、旧快照缺字段、恢复时过滤 / 去重 / 上限及视图保留、连续记录封顶 50、历史重排不修改已建立的播放队列。
- 2 项缺陷探针成功复现上述问题。探针退出成功代表断言符合预期，不代表没有缺陷。
- 本机脚本及结果：`D:/MyConfiguration/TCLDUSER/AppData/Local/Temp/bmuisc-recent-review-20260921/verify.cjs`、同目录 `results.json`。
- 当前改动不涉及 Rust 或安装包，未重复执行无关构建；真实媒体时序与桌面交互仍需后续实机验收。
