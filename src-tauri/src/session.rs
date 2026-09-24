//! 账号会话：B 站扫码登录 + 凭证安全存储。
//! 硬约束（docs/login-fav-research.md §2）：凭证（SESSDATA/bili_jct 等）只存 OS 安全存储
//! （Windows 凭据管理器 / macOS 钥匙串），绝不明文落盘、不进日志、不返回给前端；
//! 前端只拿 mid/昵称/头像等展示信息。

use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

const SERVICE: &str = "bMuisc";
const ACCOUNT: &str = "session";

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
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PollDto {
    /// waiting 未扫码 / scanned 已扫待确认 / expired 已过期 / success 登录成功
    pub status: &'static str,
    pub user: Option<UserDto>,
}

pub async fn qr_generate() -> Result<QrStart, String> {
    let v = crate::bilibili::api_json(
        "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
        None,
    )
    .await?;
    let d = &v["data"];
    let url = d["url"]
        .as_str()
        .ok_or("响应缺少二维码内容")?
        .to_string();
    let qrcode_key = d["qrcode_key"]
        .as_str()
        .ok_or("响应缺少 qrcode_key")?
        .to_string();
    Ok(QrStart { url, qrcode_key })
}

enum Outcome {
    Waiting,
    Scanned,
    Expired,
    Success(SessionBlob),
}

pub async fn qr_poll(qrcode_key: &str) -> Result<PollDto, String> {
    let outcome = poll_once(qrcode_key).await?;
    Ok(match outcome {
        Outcome::Waiting => PollDto { status: "waiting", user: None },
        Outcome::Scanned => PollDto { status: "scanned", user: None },
        Outcome::Expired => PollDto { status: "expired", user: None },
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

async fn poll_once(qrcode_key: &str) -> Result<Outcome, String> {
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
    save(&blob)?;
    log::info!("[session] 扫码登录成功 mid={}", blob.mid);
    Ok(Outcome::Success(blob))
}
