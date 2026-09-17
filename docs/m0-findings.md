# M0 技术验证记录

本文记录 M0 阶段（媒体可行性验证）的实测数据与结论，对应 [项目规划](project-plan.md) 第 7 节。所有结论基于标注日期的真实请求；B 站接口与风控策略可能随时变化，引用时注意时效。按安全约定，本文不记录带签名的完整媒体地址。

## 1. 验证环境与方法

- 日期：2026-09-17
- 环境：Windows 10（19045）；Node.js 22.20（undici fetch）与 curl 8.12.1（mingw64，Schannel TLS）
- 测试样本：`BV1cLeE6yE9R`（LE SSERAFIM 'Made My Night' Dance Practice，单 P，约 2 分钟）
- 访问方式：全程匿名，无 cookie、无 WBI 签名、无登录凭据

复现路径（详见附录）：view API 取元信息与 cid → playurl（fnval=16）取 DASH 分轨 → Range 请求探测音频流可达性。

## 2. 实测结论

### 2.1 API 匿名访问可用

| 接口 | 结果 |
| --- | --- |
| `GET /x/web-interface/view?bvid=` | 返回标题、UP 主、cid、分 P 数、时长等完整元信息 |
| `GET /x/player/playurl?bvid=&cid=&qn=64&fnval=16` | 返回 DASH 分轨数据 |

- 请求仅需 `User-Agent` 头；未要求 WBI 签名或 cookie（当前时点）。
- 存在**概率性 -400（请求错误）**：相同请求偶发被拒，间隔重试即可恢复。调用方应内置有限次重试，不可将单次 -400 视为永久拒绝。
- 诊断建议：遇到 -400 先核对请求参数本身（如 bvid 是否有效），再怀疑风控——本次排查中部分 -400 实为查询了无效 `bvid=-`。

### 2.2 独立音频流可用（产品核心前提成立）

playurl（fnval=16）返回 DASH `dash.audio` 数组，样本含 3 档独立音频流：

| id | 编码 | 实测 bandwidth | 主机形态 |
| --- | --- | --- | --- |
| 30232 | mp4a.40.2（AAC） | 约 60 kbps | PCDN |
| 30216 | mp4a.40.2（AAC） | 约 66 kbps | PCDN |
| 30280 | mp4a.40.2（AAC） | 约 111 kbps | PCDN |

- 容器为 fMP4/M4A（响应体第 4–8 字节为 `ftyp` 魔数）。
- 仅带 `User-Agent` 的 Range 请求返回 **206**，流可直接拉取，未要求 Referer。
- 响应中音频流的 `size` 字段为 0（未提供），总大小需由 bandwidth × 时长估算，或经 HEAD / Content-Range 获取。
- 音频档位未受未登录限制；对比之下视频轨匿名上限为 480P（见 2.3）。

### 2.3 视频轨与匿名限制

- 样本视频轨：480P（id 32，avc1.64001F / hvc1）与 360P（id 16，avc1.64001E / hvc1），各两路编码。
- `accept_description` 虽列出至 1080P+，但匿名实际下发的 `dash.video` 仅 480P/360P，即**匿名视频清晰度上限**；音频不受影响。
- 存在 HEVC（hvc1）编码选项。WebView2 通常不含 HEVC 解码器（依赖系统安装 HEVC 扩展），播放时需按 `codecs` 字段过滤，优先选择 AVC（avc1）轨。

### 2.4 CDN/PCDN 域名形态（对架构影响最大）

实测流地址主机形态（路径与签名参数已省略）：

- `xy*.mcdn.bilivideo.cn:8082` — PCDN 节点，**http 明文**
- `edge.mountaintoys.cn:4483` — 与 B 站无直接关联的第三方 PCDN 域名，**http 明文**

结论：

1. **流媒体域名不可预知**，会出现看似与 B 站无关的第三方域名。规划中「按域名白名单限制代理」的设想不成立。
2. 多数流为 **http 明文**：https 应用页面直接加载属于混合内容，会被 WebView 阻止。
3. 因此**本地媒体代理为必选项**，且须采用**注册表模式**：只有经解析流程登记的流 URL 才可被代理转发，不提供任意 URL 代理。代理统一补 UA/Referer 头、透传 Range，同时消除混合内容问题（WebView 将 `http://127.0.0.1` 视为可信任来源，允许加载）。

### 2.5 未登录网页自动暂停

用户在网页端观察到未登录播放会被自动暂停。经上述验证，流地址本身匿名可访问，该暂停是 B 站网页播放器的前端强制行为（引导登录），不影响本项目解析与播放流。但它表明平台正在收紧匿名观看体验，匿名可访问范围需在后续验证中持续复核。

## 3. 对方案的影响

| 原方案假设 | 实测后调整 |
| --- | --- |
| 本地代理为「确有必要再评估」的备选项 | **必选项**（PCDN 域名不可预知 + http 混合内容，双重原因） |
| 代理按「允许的媒体域名」白名单限制 | 改为按解析结果**注册放行**（注册表模式） |
| WBI 签名可能必需 | 当前匿名路径未要求；适配器保留实现位，仅在接口要求时启用 |
| 将流地址直接交给 WebView 播放 | 不可行；统一经本地代理转发 |

尚未验证：Rust 侧 HTTP 客户端（reqwest）是否同样通过风控（本次 undici 与 curl 均通过）。若 reqwest 被拦，再评估模拟浏览器 TLS 或在 WebView 内发起请求。

## 4. M0 剩余验证项

- [ ] 多分 P 视频的元信息与各分 P cid 解析
- [ ] 临时流地址有效期（实测过期时间与刷新方式）
- [ ] WebView2 内 `<audio>` 实播：加载、seek、音质档位选择
- [ ] 音频模式网络核验：经代理日志确认零视频流量
- [ ] 音视频切换：进度对齐、无双重声音、失败回退音频
- [ ] reqwest 风控通过性
- [ ] 长视频 seek 缓冲表现

## 5. 附录：复现步骤

```bash
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
BV=BV1cLeE6yE9R

# 1) 元信息与 cid（遇 -400 稍候重试）
curl -s -A "$UA" "https://api.bilibili.com/x/web-interface/view?bvid=$BV"

# 2) 播放地址（fnval=16 → DASH 分轨；cid 取上一步 data.cid）
curl -s -A "$UA" "https://api.bilibili.com/x/player/playurl?bvid=$BV&cid=<CID>&qn=64&fnval=16"

# 3) 音频流探测（baseUrl 取 data.dash.audio[].baseUrl；期望 HTTP 206 且文件头第 4–8 字节为 ftyp）
curl -s -r 0-1023 -A "$UA" "<audio_baseUrl>" | head -c 16 | xxd
```

注意：baseUrl 含签名与时效参数，不写入任何文档或日志；每次播放前重新解析获取。
