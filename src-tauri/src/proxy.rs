//! 本地媒体代理：注册表模式（docs/m0-findings.md §2.4）。
//! 只有经解析流程登记的流 URL 才会被转发，不提供任意 URL 代理。
//! 实测修正：开放式 Range 切成有界分块；候选地址官方 CDN 优先，失败轮替。

use axum::body::Body;
use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const REFERER: &str = "https://www.bilibili.com/";
// 风控实测（2026-09-18，详见 docs/m0-findings.md §2.1/§2.2）：媒体 CDN 与 API 规则相反——
// 官方镜像（upos-sz-*/cn-jstz-*）**必须带 Referer**（否则 403），mcdn PCDN 节点带不带均可。
// 拉流请求统一带 Referer。
const CHUNK: u64 = 1024 * 1024; // 开放式 Range 分块大小：1MB

struct Entry {
    urls: Vec<String>,
    _kind: &'static str,
}

fn registry() -> &'static Mutex<HashMap<String, Entry>> {
    static REG: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

// 锁持有方 panic 后其余线程照常工作，不因锁中毒连锁 panic
fn lock_registry() -> std::sync::MutexGuard<'static, HashMap<String, Entry>> {
    registry().lock().unwrap_or_else(|p| p.into_inner())
}

static SEQ: AtomicU64 = AtomicU64::new(0);
static PORT: OnceLock<u16> = OnceLock::new();

fn is_official(url: &str) -> bool {
    // host 含官方 CDN 域名（upos-sz-*.bilivideo.com / akamaized.net）视为稳定源
    url.contains("bilivideo.com") || url.contains("akamaized.net")
}

/// 登记一条流的全部候选地址（baseUrl + backupUrl），官方镜像优先。
pub fn register(mut urls: Vec<String>, kind: &'static str) -> String {
    urls.dedup();
    urls.sort_by_key(|u| !is_official(u)); // 稳定的官方 CDN 排前
    urls.dedup();
    let key = format!("s{}", SEQ.fetch_add(1, Ordering::Relaxed) + 1);
    lock_registry().insert(key.clone(), Entry { urls, _kind: kind });
    key
}

pub fn port() -> u16 {
    PORT.get().copied().unwrap_or(0)
}

/// 开放式 Range（bytes=N-）切成有界请求；有界/后缀 Range 原样透传。
fn normalize_range(range: Option<&str>) -> Option<String> {
    let range = range?.trim();
    let rest = range.strip_prefix("bytes=")?.trim();
    // 后缀形式 bytes=-N（读末尾 N 字节）：语义合法，原样透传，丢弃会退化成整段传输
    if let Some(suffix) = rest.strip_prefix('-') {
        suffix.trim().parse::<u64>().ok()?;
        return Some(range.to_string());
    }
    let (start, end) = rest.split_once('-')?;
    let start: u64 = start.trim().parse().ok()?;
    match end.trim().parse::<u64>() {
        Ok(_) => Some(range.to_string()), // 有界：原样
        Err(_) => Some(format!("bytes={}-{}", start, start + CHUNK - 1)), // 开放式：切块
    }
}

async fn stream(Path(key): Path<String>, headers: HeaderMap) -> Response {
    let entry = lock_registry().get(&key).map(|e| e.urls.clone());
    let urls = match entry {
        Some(u) => u,
        None => {
            return (StatusCode::NOT_FOUND, "未注册的流（请先解析）").into_response();
        }
    };

    let range_in = headers
        .get(axum::http::header::RANGE)
        .and_then(|v| v.to_str().ok());
    let upstream_range = normalize_range(range_in);

    let client = reqwest::Client::builder()
        .user_agent(UA)
        .http1_only() // 媒体 CDN 同样以 HTTP/1.1 访问，与 API 保持一致
        .timeout(Duration::from_secs(30))
        .build()
        .expect("proxy client");

    for url in urls {
        let mut req = client
            .get(&url)
            .header("Referer", REFERER) // 官方 CDN 无 Referer 返回 403（§2.2）
            .timeout(Duration::from_secs(120));
        if let Some(r) = &upstream_range {
            req = req.header("Range", r);
        }
        let up = match req.send().await {
            Ok(u) => u,
            Err(_) => continue, // 换下一个候选
        };
        let status = up.status();
        if status.is_client_error() || status.is_server_error() {
            // 4xx（403/404/416 等）：地址失效、节点拒绝或个别节点 Range 异常；
            // 5xx（500/502/503 等）：该节点临时故障。二者都轮替候选，
            // 全部失败时落到循环外的 502 统一报错，不把坏状态透传给播放器。
            // （实测 2026-09-20：个别节点对合法 Range 返回 416，透传会误伤正常播放）
            continue;
        }

        let mut resp = Response::builder().status(status);
        let headers = resp.headers_mut().unwrap();
        headers.insert("accept-ranges", "bytes".parse().unwrap());
        headers.insert("cache-control", "no-store".parse().unwrap());
        // 允许 WebView 前端以 crossorigin 方式拉流，供 WebAudio 频谱分析（仅本机回环）
        headers.insert("access-control-allow-origin", "*".parse().unwrap());
        if let Some(ct) = up.headers().get("content-type") {
            headers.insert("content-type", ct.clone());
        } else {
            headers.insert("content-type", "audio/mp4".parse().unwrap());
        }
        for h in ["content-length", "content-range"] {
            if let Some(v) = up.headers().get(h) {
                headers.insert(h, v.clone());
            }
        }
        let body = Body::from_stream(up.bytes_stream());
        return resp.body(body).unwrap();
    }
    (
        StatusCode::BAD_GATEWAY,
        "所有候选地址拉流失败（地址可能已过期，请重新解析）",
    )
        .into_response()
}

/// CORS 预检：media 元素带 Range 的跨源请求可能先发 OPTIONS
async fn stream_options() -> Response {
    let mut resp = StatusCode::OK.into_response();
    let headers = resp.headers_mut();
    headers.insert("access-control-allow-origin", "*".parse().unwrap());
    headers.insert("access-control-allow-headers", "range, content-type".parse().unwrap());
    headers.insert("access-control-allow-methods", "GET, OPTIONS".parse().unwrap());
    headers.insert("access-control-max-age", "86400".parse().unwrap());
    resp
}

pub async fn spawn() -> Result<(), String> {
    let app = Router::new()
        .route("/audio/{key}", get(stream).options(stream_options))
        .with_state(());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();
    PORT.set(port).ok();
    eprintln!("本地媒体代理已启动: http://127.0.0.1:{port}（仅监听回环）");
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app).await {
            eprintln!("代理服务异常退出: {e}");
        }
    });
    Ok(())
}
