//! 账号会话：B 站扫码登录 + 凭证安全存储。
//! 硬约束（docs/login-fav-research.md §2）：凭证（SESSDATA/bili_jct 等）只存 OS 安全存储
//! （Windows 凭据管理器 / macOS 钥匙串），绝不明文落盘、不进日志、不返回给前端；
//! 前端只拿 mid/昵称/头像等展示信息。

use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

const SERVICE: &str = "bMuisc";
const ACCOUNT: &str = "session";

/// 登录代际状态。不变式：attempt 的任何变化都伴随 epoch 递增
/// （开始新尝试 / 定向取消 / 全部作废都会换代），因此「代际号未变」
/// 即「期间没有发生过作废或替代」。
struct LoginGate {
    epoch: u64,              // 当前登录代际号
    attempt: Option<String>, // 活跃登录尝试的 ID（前端生成，随 generate/cancel 传入）
}

/// 登录互斥锁：换代入口（begin_attempt / cancel_attempt / invalidate_all）与
/// poll 的「最终代际校验 + 凭证写入」共用此锁，网络请求一律在锁外——
/// 否则新取码的换代能插进旧请求的「校验通过 → 写入完成」之间（复审 P2-②）。
/// 临界区内只有同步操作，无 await。
static LOGIN_LOCK: Mutex<LoginGate> = Mutex::new(LoginGate { epoch: 0, attempt: None });

fn login_lock() -> MutexGuard<'static, LoginGate> {
    LOGIN_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn epoch_alive(epoch: u64) -> bool {
    login_lock().epoch == epoch
}

/// 开始新登录尝试（qr_generate 入口）：换代并记录尝试 ID。
/// 取码请求尚未返回时尝试已登记——之后关窗取消同样能命中（复审 P2-①）。
fn begin_attempt(attempt: &str) -> u64 {
    let mut g = login_lock();
    g.epoch += 1;
    g.attempt = Some(attempt.to_string());
    g.epoch
}

/// 定向作废一次登录尝试（扫码弹窗卸载时）：尝试 ID 匹配当前活跃尝试才生效——
/// 旧弹窗迟到的取消请求不会作废新弹窗的登录（复审 P2-①）。
pub fn cancel_attempt(attempt: &str) {
    let mut g = login_lock();
    if g.attempt.as_deref() == Some(attempt) {
        g.epoch += 1;
        g.attempt = None;
    }
}

/// 作废所有登录尝试（登出 / 删除凭证前）。
fn invalidate_all() {
    let mut g = login_lock();
    g.epoch += 1;
    g.attempt = None;
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SessionBlob {
    pub sessdata: String,
    pub bili_jct: String,
    pub mid: u64,
    #[serde(default)]
    pub uname: String,
    #[serde(default)]
    pub face: String,
    #[serde(default)]
    pub saved_at: u64,
}

fn entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| format!("系统安全存储不可用: {e}"))
}

pub fn load() -> Option<SessionBlob> {
    let e = entry().ok()?;
    let raw = e.get_password().ok()?;
    match serde_json::from_str::<SessionBlob>(&raw) {
        Ok(b) if !b.sessdata.is_empty() => Some(b),
        _ => {
            // 条目损坏/为空：清掉按未登录处理
            let _ = e.delete_credential();
            None
        }
    }
}

fn save(blob: &SessionBlob) -> Result<(), String> {
    let e = entry()?;
    let raw = serde_json::to_string(blob).map_err(|e| e.to_string())?;
    e.set_password(&raw).map_err(|e| format!("凭证保存失败: {e}"))
}

pub fn delete() -> Result<(), String> {
    // 登出/清理：先换代作废所有在途登录（与迟到落库互斥），再删除凭证
    invalidate_all();
    let e = entry()?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("凭证删除失败: {e}")),
    }
}

/// 带登录态 API 请求的 Cookie 头（只在 Rust 进程内使用，绝不外发/落日志）
pub(crate) fn cookie_header(blob: &SessionBlob) -> String {
    format!(
        "SESSDATA={}; bili_jct={}; DedeUserID={}",
        blob.sessdata, blob.bili_jct, blob.mid
    )
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------- 前端 DTO ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UserDto {
    pub mid: u64,
    pub uname: String,
    pub face: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StateDto {
    pub logged_in: bool,
    pub user: Option<UserDto>,
}

pub fn state_dto() -> StateDto {
    match load() {
        Some(b) => StateDto {
            logged_in: true,
            user: Some(UserDto {
                mid: b.mid,
                uname: b.uname,
                face: b.face,
            }),
        },
        None => StateDto {
            logged_in: false,
            user: None,
        },
    }
}

// ---------- 扫码登录（Web 二维码，现行 /x/passport-login/web 接口） ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QrStart {
    pub url: String,      // 二维码内容串（前端自行渲染成图）
    pub qrcode_key: String, // 轮询凭证
    pub epoch: u64,       // 登录代际号：轮询须回传，原生侧落库前校验
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PollDto {
    /// waiting 未扫码 / scanned 已扫待确认 / expired 已过期 / success 登录成功
    /// / cancelled 登录已作废（关窗/登出/开始新登录后迟到返回，未落库）
    pub status: &'static str,
    pub user: Option<UserDto>,
}

pub async fn qr_generate(attempt: &str) -> Result<QrStart, String> {
    // 尝试开始即换代并登记尝试 ID（持锁，复审 P2-②）；取码请求乱序返回时只有
    // 「最后开始的取码」仍有效——旧弹窗的迟到取码在下面被拒绝，不会反过来
    // 作废新弹窗的二维码（复审 P2-③）
    let epoch = begin_attempt(attempt);
    let v = crate::bilibili::api_json(
        "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
        None,
    )
    .await?;
    if !epoch_alive(epoch) {
        // 分配后已被作废（关窗取消/登出/开始了更新的取码）：拒绝迟到响应
        return Err("登录已取消".into());
    }
    let d = &v["data"];
    let url = d["url"]
        .as_str()
        .ok_or("响应缺少二维码内容")?
        .to_string();
    let qrcode_key = d["qrcode_key"]
        .as_str()
        .ok_or("响应缺少 qrcode_key")?
        .to_string();
    Ok(QrStart { url, qrcode_key, epoch })
}

enum Outcome {
    Waiting,
    Scanned,
    Expired,
    Success(SessionBlob),
    Cancelled,
}

pub async fn qr_poll(qrcode_key: &str, epoch: u64) -> Result<PollDto, String> {
    let outcome = poll_once(qrcode_key, epoch).await?;
    Ok(match outcome {
        Outcome::Waiting => PollDto { status: "waiting", user: None },
        Outcome::Scanned => PollDto { status: "scanned", user: None },
        Outcome::Expired => PollDto { status: "expired", user: None },
        Outcome::Cancelled => PollDto { status: "cancelled", user: None },
        Outcome::Success(b) => PollDto {
            status: "success",
            user: Some(UserDto {
                mid: b.mid,
                uname: b.uname,
                face: b.face,
            }),
        },
    })
}

async fn poll_once(qrcode_key: &str, epoch: u64) -> Result<Outcome, String> {
    let url = format!(
        "https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key={qrcode_key}"
    );
    let resp = crate::bilibili::client()
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {e}"))?;
    // Set-Cookie 头先取走（json() 会消费 response）
    let set_cookies: Vec<String> = resp
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|h| h.to_str().ok().map(|s| s.to_string()))
        .collect();
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败: {e}"))?;
    match v["data"]["code"].as_i64() {
        Some(86101) => return Ok(Outcome::Waiting),
        Some(86090) => return Ok(Outcome::Scanned),
        Some(86038) => return Ok(Outcome::Expired),
        Some(0) => {}
        Some(c) => return Err(format!("扫码状态异常（{c}）")),
        None => return Err("响应格式异常".into()),
    }
    // 成功：凭证在本次响应的 Set-Cookie 头里。只取需要的三个名字，
    // 不解析跳转 url（里面同样带凭证，不碰不记录）。
    let (mut sessdata, mut bili_jct, mut mid) = (None, None, None);
    for s in &set_cookies {
        let pair = s.split(';').next().unwrap_or_default();
        let (name, val) = pair.split_once('=').unwrap_or(("", ""));
        match name.trim() {
            "SESSDATA" => sessdata = Some(val.trim().to_string()),
            "bili_jct" => bili_jct = Some(val.trim().to_string()),
            "DedeUserID" => mid = val.trim().parse::<u64>().ok(),
            _ => {}
        }
    }
    let (sessdata, bili_jct, mid) = match (sessdata, bili_jct, mid) {
        (Some(a), Some(b), Some(m)) => (a, b, m),
        _ => return Err("登录响应缺少凭证".into()),
    };
    // 代际校验①：响应返回时登录可能已被作废（关窗/登出/换新码）——不再发后续请求
    if !epoch_alive(epoch) {
        return Ok(Outcome::Cancelled);
    }
    let mut blob = SessionBlob {
        sessdata,
        bili_jct,
        mid,
        uname: String::new(),
        face: String::new(),
        saved_at: now(),
    };
    // 顺带取昵称头像做展示；失败不阻塞登录（UI 显示 mid 兜底）
    if let Ok(v) = crate::bilibili::api_json(
        "https://api.bilibili.com/x/web-interface/nav",
        Some(&cookie_header(&blob)),
    )
    .await
    {
        blob.uname = v["data"]["uname"].as_str().unwrap_or_default().to_string();
        blob.face = v["data"]["face"].as_str().unwrap_or_default().to_string();
    }
    // 代际校验②：最终校验与写入同持登录锁（复审 P2-②），与所有换代入口
    // （begin_attempt / cancel_attempt / invalidate_all）互斥——先作废则此处
    // 必失败，不会出现「换代已发生，旧请求仍把凭证写入并返回成功」。
    // 持锁期间直接比较字段（epoch_alive 会再次拿锁，重入死锁）
    {
        let g = login_lock();
        if g.epoch != epoch {
            return Ok(Outcome::Cancelled);
        }
        save(&blob)?;
    }
    log::info!("[session] 扫码登录成功 mid={}", blob.mid);
    Ok(Outcome::Success(blob))
}
