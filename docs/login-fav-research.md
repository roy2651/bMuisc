# 扫码登录与收藏夹调研（2026-09-24）

路线图下一步（M4 账号能力）的前置调研。结论先行：Web 扫码登录与收藏夹读写在技术上都是成熟的公开 Web 接口，社区工具（BBDown/BBPlayer/PiliPala 等）多年验证，对接无未知风险；工作量集中在凭证安全存储与前端 UI。

## 1. 扫码登录（Web 二维码流程）

现行接口（旧文档里的 `passport.bilibili.com/qrcode/getLoginUrl` + `getLoginInfo` 是已废弃的老流程，网上不少镜像还写着它们，别用）：

| 步骤 | 接口 | 说明 |
|---|---|---|
| 生成 | `GET https://passport.bilibili.com/x/passport-login/web/qrcode/generate` | 返回 `data.url`（二维码内容串）+ `data.qrcode_key`；自己渲染二维码（无用户交互门槛） |
| 轮询 | `GET https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=...` | 1~2s 间隔（BBDown 用 1s），二维码有效期 180s |

轮询 `data.code` 状态机：`86101` 未扫码 → `86090` 已扫未确认 → `0` 成功；`86038` 已过期（重新 generate 整个流程重来）。

成功后凭证的两种取法（等价）：
- **Set-Cookie 响应头**：Rust 侧直接读 `resp.headers().get_all(SET_COOKIE)`，含 `SESSDATA`（HttpOnly）、`bili_jct`（CSRF）、`DedeUserID`（mid）、`DedeUserID__ckMd5`、`sid`；
- 响应体 `data.url`：跨域跳转链接，query 参数与 cookie 一一对应（BBDown 走这条路）。我们用 Set-Cookie 即可，不解析也不落日志这个 url。

各 Cookie 用途：
| Cookie | 用途 |
|---|---|
| `SESSDATA` | 鉴权凭证，所有带登录态请求必带 |
| `bili_jct` | CSRF token，所有 POST 写操作必带（作为 `csrf` 参数） |
| `DedeUserID` | 用户 mid——查自己收藏夹列表要用（`up_mid`） |
| `buvid3` 等 | 设备指纹，登录响应顺带返回；基本读接口用不上 |

用户信息展示：`GET api.bilibili.com/x/web-interface/nav`（带 SESSDATA）→ `isLogin`/`uname`/`face`/`mid`。实现时验证。

凭证有效期：SESSDATA 实际约 1 个月，官方另有 cookie 刷新机制（correspond/refresh 流程，较复杂且文档散）。**第一版不做刷新**：过期后接口返回 `-101`，引导重新扫码。

## 2. 凭证存储设计（硬约束：SESSDATA 只进 OS 安全存储，绝不明文）

- 方案：`keyring` crate（`windows-native` feature → Windows 凭据管理器；`apple-native` → macOS 钥匙串），存一个 JSON blob（全部登录 cookie + 时间戳），service=`bMuisc`，account=`session`。
- **凭证只存在于 Rust 进程内存 + OS 安全存储**：不进 localStorage/快照（那里是明文盘上文件），不进日志（连 `data.url` 都不打），不发给前端。前端只拿 UI 数据：登录状态、mid、昵称、头像 URL。
- 所有带登录态的 API 调用都走 Rust commands（前端不持有 cookie，自然也不会泄漏）。
- 登出 = keyring 删除条目（B 站侧主动注销接口可后置）。

## 3. 收藏夹接口（B 站无"歌单"，视频源对应物 = 收藏夹）

### 读
| 接口 | 说明 |
|---|---|
| `GET api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid={mid}&type=2` | 自己创建的全部收藏夹（带 SESSDATA 时**含私密夹**），返回 `list[]`: `id`(mlid)/`title`/`media_count`/`attr`（位0=私密） |
| `GET api.bilibili.com/x/v3/fav/resource/list?media_id={mlid}&pn&ps=20&order=mtime` | 收藏夹内容，**ps 上限 20**；返回 `medias[]`: `id`(=aid)、`bvid`、`title`、`cover`、`duration`、`upper.name`、`page`(分P数)、`attr`（1/9=已失效）、`fav_time`；`has_more` 翻页，无 total（用 `info.media_count`） |
| `GET api.bilibili.com/x/player/pagelist?bvid=...` | 收藏夹列表**不返回 cid**——导入时逐条用 pagelist 换 cid+分P 标题（匿名可用，与现有 view 解析同族） |

失效视频（`attr != 0`）无法播放，导入时跳过并在 UI 标记。

### 写（全部 POST，form-urlencoded，必带 `csrf=bili_jct`）
| 接口 | 参数 |
|---|---|
| `POST api.bilibili.com/x/v3/fav/folder/add` 新建收藏夹 | `title`（必要）、`intro`、`privacy`（0 公开/1 私密）、`csrf` |
| `POST api.bilibili.com/x/v3/fav/folder/edit` / `folder/del` | `media_id` / `media_ids`（逗号分隔）+ `csrf` |
| `POST api.bilibili.com/x/v3/fav/resource/deal` 收藏/取消收藏视频 | `rid`=**aid**（不是 bvid）、`type`=2（视频稿件）、`add_media_ids`/`del_media_ids`=收藏夹 mlid、`csrf` —— 红心双向同步的基础 |

错误码：`-101` 未登录 / `-111` csrf 校验失败 / `-403` 权限不足 / `11010` 内容不存在。

## 4. 与本地模型的映射

本地已有 `TrackKey=${bvid}:${cid}`、playlists 只存 key 引用（v0.2.0 架构），映射天然：

- **导入（B站 → 本地）**：选收藏夹 → 拉 medias（20/页翻页）→ 逐条 pagelist 换 cid（多P 全部展开成多轨，与合集语义一致）→ 建/更新本地歌单，记来源 `bili:mlid` 供后续增量。
- **"新建歌单"两条路**：本地新建（已实现）；B 站侧新建收藏夹（`folder/add`，作为写回目标）。

### 本地 → B 站（写回，用户已确认要做）

把登录前积累的本地曲库/歌单推送到 B 站收藏夹：

- **歌单绑定**：本地歌单元数据加可选 `biliMlid`（导入建的自动带上；纯本地歌单推送时可绑定已有夹或新建夹——`folder/add` 后把返回 id 写入绑定）。
- **推送流程**：歌单内曲目**按 bvid 去重聚合**（同一视频的多 P 合并为一个稿件）→ 对每个 bvid 取 aid（view 接口，顺带校验 cid）→ 逐条 `fav/resource/deal`（`rid=aid, type=2, add_media_ids=绑定的mlid`）。deal 对已收藏的稿件重复推送无副作用（B 站侧同稿件在夹内只一份），天然幂等，可反复全量推送。
- **分P 粒度限制（关键语义差）**：B 站收藏夹的收藏粒度是**稿件**（aid），不存在"只收藏某一 P"。本地歌单里选了某视频的第 3 P，推上去 = 收藏整个视频；B 站侧和之后导入回来看到的都是整个稿件（多 P 全展开，内容不丢，但"只推一 P"这个选择无法在 B 站表达）。UI 文案要如实提示。
- **失效容错**：本地存的 bvid 可能已下架——逐条 deal 失败（11010 等）不中断整批，结束后汇报成功/失败清单。
- **速率**：一个歌单几十首 = 几十次 deal（按 bvid 去重后更少），串行加小间隔即可；写操作量小且用户主动，与"无批量抓取"约束不冲突。
- **新建夹隐私**：`folder/add` 的 `privacy` 建议默认 1（私密），UI 允许改公开——避免把用户的听歌记录默认公开到主页。
- **红心写回**（后续）：「我的喜欢」↔ B 站默认收藏夹，同 deal 通道。

## 5. 音频区内容（收藏夹里的 type=12）——第一版不做

收藏夹内容列表里除了视频稿件（type=2），还可能出现 **type=12 音频**（B 站音频区歌曲，id 为 auid，无 bvid）。音频区是独立内容体系，与视频稿件的关键差异：

- **流接口必须登录**：`GET api.bilibili.com/audio/music-service-c/url?songid={auid}&quality=2&privilege=2&mid={mid}` 需 SESSDATA（或 APP access_key）才返回 `cdns` 音频流地址；匿名拿不到流。付费歌曲无大会员/音乐包只返回试听片段（type=-1），无损 FLAC 需会员。流地址有效期约 3 小时（比视频流的 ~25min 宽裕）。
- **播放管线不匹配**：本地模型 TrackKey=`${bvid}:${cid}`、回环代理、pagelist/合集展开全部围绕视频稿件；音频区无分P、另一套 CDN 与鉴权，接入是独立工程。
- **内容面在收缩**：B 站音频区已停止新投稿，只剩存量内容，投入产出比低。

处理决定：收藏夹导入只吃 `type=2`（视频稿件），type=12 跳过并在导入结果提示「N 条音频条目暂不支持」。

## 6. 风险与约束核对

- **WAF**：passport/api 走现有 reqwest client（native-tls/Schannel + http1_only + UA-only），指纹与匿名访问同构，传输层不新增风险。带 Cookie 的 API 请求**同样不带 Referer**（api 域禁 Referer 规则不变）。
- **执法潮/账号绑定**（platform-feasibility.md）：登录态让行为与账号关联，风险高于纯匿名。缓解：只拉自己的数据、分页 20 条受控翻页、cid 懒解析（只对导入/播放中的条目）、无批量抓取——与硬约束一致。
- **失效内容**：attr 标记的失效视频处理为跳过+标记，不做恢复。

## 7. 实施分步建议

1. **登录**（~1.5 天）：Rust keyring 存储 + `login_qrcode_generate`/`login_qrcode_poll`/`login_state`/`login_logout` commands + 前端设置页账号区（QR 弹窗、轮询状态显示、过期重试、头像昵称、登出）。
2. **收藏夹导入**（~1 天）：`fav_folders`/`fav_resources` commands + 歌单区「导入B站收藏夹」入口 + pagelist 解析与失效标记。
3. **写回（用户已确认要做）**（~1 天）：歌单绑定 `biliMlid` + 「推送到B站」（新建/选择收藏夹 → 按 bvid 去重 → deal 逐条推送 + 失败清单）+ 分P 粒度提示文案；红心写回后置。

## 来源

- [bilibili-API-collect 镜像 · 二维码登录](https://lxb007981.github.io/bilibili-API-collect/login/login_action/QR.html)（注意该镜像部分内容为旧版接口）
- [DeepWiki · BBDown Authentication](https://deepwiki.com/nilaoda/BBDown/4.2-authentication)（现行 generate 接口与状态码的工程实现印证）
- [bilibili-API-collect 镜像 · 收藏夹基本信息](https://janson20.github.io/bilibili-api-collect-mirror/docs/fav/info.html)
- [bilibili-API-collect 镜像 · 收藏夹内容](https://janson20.github.io/bilibili-api-collect-mirror/docs/fav/list.html)
- [bilibili-API-collect 镜像 · 收藏夹操作](https://janson20.github.io/bilibili-api-collect-mirror/docs/fav/action.html)
- [BBPlayer 登录文档](https://bbplayer-app-bbplayer.mintlify.app/features/bilibili-login)

## 8. 实施现状（2026-09-24，已实现并实测）

- **登录入口外置**：顶栏 AccountMenu——未登录显示「登录」按钮直开扫码弹窗；已登录显示头像+昵称，
  菜单内含「同步B站收藏夹 / 登出」。扫码弹窗由 App 层按 `useUiBus.qrOpen` 渲染，设置与顶栏共用。
- **同步语义统一叫「同步」**（不用「导入/下载」措辞，图标为循环箭头 IconSync）：
  - 读（B站→本地）：`FavImportModal` 选收藏夹 → `fav_resources` → 逐条 `resolve_view`（250ms 限速）→ 本地歌单，
    按 `biliMlid` 绑定增量更新；已绑定行显示「已同步为歌单X」并可删除本地歌单。
  - 写（本地→B站）：歌单页头部常驻「同步到B站」按钮（登录后可见）→ `FavPushModal`（新建收藏夹默认私密 /
    选已有；按 bvid 去重逐条 `fav/resource/deal`，350ms 限速，幂等）。B站收藏夹粒度=稿件，多P合并。
- **删除/清除三档（只动本地，绝不调B站删除接口）**：
  - `clearPlaylists('synced')`：仅删 biliMlid 绑定的歌单，级联清库（orphan = 不被喜欢/保留歌单引用的键）。
  - `clearPlaylists('all')`：删全部歌单 + 同上级联。
  - `clearLibrary()`：彻底清空 lib/libOrder/favs/recent/playlists，恢复空白。歌单必须一起删——
    否则歌单里的曲库键悬空，重新同步会"复活"旧曲目。
  - `removeFromLib(keys)`：单首/批量移出曲库，连带清喜欢与最近播放引用；队列持副本不受影响。
- **删除类操作统一 ConfirmModal 弹框确认**（删歌单/从音乐库删除/队列清空/三档清除/删本地同步歌单）。
  新建歌单走 `NewPlaylistModal` 弹窗（侧栏 + 与行菜单共用，同名提示将复用）。
- **级联删除规则**：删歌单时仅移除「不被 我的喜欢 和 其余保留歌单引用」的曲目；被引用的保留。
- **其他**：WebView 默认右键菜单全局屏蔽（`contextmenu` preventDefault）；侧栏歌单用 `cloud-mark`
  小图标区分B站同步来源；歌单头部按钮行 `flex-wrap` + 搜索框可收缩，避免溢出压叠。
- **弹窗分层要点**：escStack 后进先出只关最上层；ConfirmModal 遮罩 `stopPropagation`，
  防止嵌套时冒泡触发底层弹窗的遮罩关闭。
- **侧栏歌单 ⋯ 菜单**：歌单项悬停显示 ⋯（遮住计数位），菜单=同步到B站（登录后）/ 重命名
  （RenamePlaylistModal，同名拒绝）/ 删除歌单（ConfirmModal 级联语义同列表页）。

## 9. CR 修复记录（2026-09-24，外部审查 8 个 P2 全部修复）

审查基线 HEAD `1dae0e0`，结论「暂不通过：8 P2」；以下为逐条修复（`npm run build` 通过）：

- **R1 推送任务独占 + 先锁 UI 再发请求**（FavPushModal）：`taskRef = { cancelled }` 在第一个
  await 之前建立，`setPhase('pushing')` 先于创建收藏夹请求（创建期间无第二个提交入口，
  `taskRef` 防重入）；每个 await 之后检查 `cancelled`——创建请求返回前取消，不再发后续收藏请求。
- **R2 关闭入口统一中止**（FavImportModal / FavPushModal）：`close = useCallback`（只引用 ref）
  同时被 Esc（registerEsc）、取消/X/遮罩使用；卸载 cleanup 兜底置 cancelled。
  导入中止不落库（tracks 落库前不提交）；已发出的单条推送请求无法撤回（幂等）。
- **R3 removeFromLib 级联清歌单引用**（store.ts）：删除曲库条目时同步过滤所有 `playlists[].keys`，
  `plRemoveBackup` 指向被删 key 时一并作废（防止撤销插回悬空引用）；clearLibrary 同步清备份。
- **R4 快照恢复不再让队列复活进库**（store.ts `applySnapshotData`）：仅 `data.lib` 字段缺失的
  旧版快照（v1）执行「队列迁移为曲库」；带 lib 的现代快照（v2+）严格恢复，库与队列独立——
  清空曲库→重启 libOrder 保持为空、队列仍可恢复。libOrder 缺失时 v2 由兜底循环按保存顺序补齐。
- **R5 设置弹窗滚动**：新增 `.set-body`（flex:1 + overflow-y:auto）内容区，标题/关闭键常驻；
  880×580 下底部行可达。
- **R6 弹窗焦点陷阱全覆盖**：LoginQrModal / ConfirmModal / NewPlaylistModal / RenamePlaylistModal /
  ParseModal / FavPushModal / FavImportModal 统一接 `useModalFocus`（trapStack 栈约定：多层弹窗只有
  最上层吃 Tab）+ `role="dialog" aria-modal="true"`；useModalFocus 不再抢容器内 autoFocus 输入框的
  焦点；ConfirmModal 默认聚焦容器而非确认键。
- **R7 窄窗侧栏菜单**：菜单 portal 到 body、fixed 定位（坐标取 ⋯ 按钮 `getBoundingClientRect`，
  底部空间不足向上翻），不再被 `.sidebar` overflow 裁切；1020px 断点 li 恢复独立定位盒
  （inline-flex chip），废除 `display: contents`；`.side-more` 补 `:focus-within`/`:focus-visible` 显示。
- **R8 推送绑定语义**（FavPushModal）：新建收藏夹必然回写 `biliMlid`；推到已有收藏夹只要有成功
  写入（ok>0）同样持久化关联（换绑/首次关联），done 页显示「歌单已关联收藏夹X」。
- **措辞统一（审查建议 2）**：「从B站导入」（导入弹窗/账号菜单/侧栏入口）/「推送到B站」
  （推送弹窗/歌单页/侧栏菜单）；导入推送进度页提供「停止」按钮 + 语义说明；推送 hint 明确
  「只追加收藏，不删除不改动B站已有内容」。
- **设置分区（审查建议 1）**：账号 / 关于与更新 / 数据管理（危险区集中底部，说明只动本机数据）。
- **审查报告遗留两项已知风险（未计入 8 个 P2，待受控原生测试）**：
  ① 原生 QR 轮询完成落库的 attempt/generation 门控（关闭/登出/再登录与迟到结果交错）；
  ② 收藏读取 50 页封顶时 has_more 仍 true 无「部分结果」标记。
- **未做（P3）**：1020px 以下导航抽屉化重排、队列抽屉遮挡优化——待下轮。

### 9.1 复审第二轮（同日，2 个 P2 已修复，build 绿）

- **F1 推送目标无效先校验后切阶段**（FavPushModal）：目标存在性（`folders.some`）/ 名称非空 /
  曲目数在 pick 态全部校验后才 `setPhase('pushing')`；staleSelected（绑定夹已被远端删除/切换账号）
  显示说明并禁用「开始推送」；pushing 态内再取目标取不到时退回 pick（兜底防卡死）。
  验收覆盖：删远端夹、切号、列表未加载完（folders=null → 按钮禁用）、空名 Enter（留选择页）。
- **F2 绑定来源区分**（store.ts）：`Playlist.biliSrc: 'import' | 'push'`，`bindPlaylistBili(id, mlid, src)`
  ——导入建立记 import，推送新建/换绑记 push；`clearPlaylists('synced')` 只清 `biliSrc !== 'push'`，
  仅推送过的本地自建歌单（用户内容）不再被「清除从B站导入的歌单」误删。旧快照无此字段按 import
  处理（保持原清理语义）。设置页计数同步改为 importedCount，文案加「本地自建、仅推送过的歌单不受影响」；
  导入弹窗对 push 来源的绑定歌单显示「推送时建立，导入将合并更新」；侧栏 cloud-mark 提示区分来源。
- **顺手修（复审备注，非阻断）**：侧栏 portal 菜单 fixed 定位后基类 `right: 8px` 仍生效导致菜单
  横向拉伸至右缘——inline `right:'auto', width:'max-content'` 清掉。

### 9.2 复审第三轮（同日，1 个 P2 已修复，build 绿）

- **P2 推送覆写导入来源**：biliSrc 语义改为「歌单建立来源，写后不变」，与可变的 mlid（当前绑定
  目标）分开——`bindPlaylistBili` 只在歌单尚无来源时记录 `biliSrc ?? src`；导入建立的歌单之后
  推送/换绑到任何收藏夹都保持 import 来源，仍可按「清除从B站导入的歌单」清理（修复实测计数
  1→0 退化）。推送侧 `src='push'` 只对「无来源的本地自建歌单首次推送」生效。
- **旧数据补记路径**（FavImportModal）：旧快照的歌单没有 biliSrc 字段，若先测推送会被误标 push
  且再导入也不纠正——导入遇到「绑定歌单来源未知」时补记 `bindPlaylistBili(id, 同夹, 'import')`。
- 验证口径：推送回原夹后 importedCount 不变；本地自建首推 → push 不进导入清理；导入建立→推送
  换绑 → 仍 import。
