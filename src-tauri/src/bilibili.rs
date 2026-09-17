//! 内容源适配器：B 站元信息与媒体地址解析。
//! 隔离平台接口变化，只暴露内部数据结构；匿名访问 + 概率性 -400 有限重试。

use regex::Regex;
use serde::Serialize;
use std::sync::OnceLock;
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const REFERER: &str = "https://www.bilibili.com/";

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(UA)
            .timeout(Duration::from_secs(15))
            .build()
            .expect("reqwest client")
    })
}

/// 接口调用：匿名 + 概率性 -400 有限重试（见 docs/m0-findings.md §2.1）
async fn bili_json(url: &str) -> Result<serde_json::Value, String> {
    let mut last = String::new();
    for i in 1..=4 {
        let resp = client()
            .get(url)
            .header("Referer", REFERER)
            .send()
            .await
            .map_err(|e| format!("网络请求失败: {e}"))?;
        let v: serde_json::Value = resp.json().await.map_err(|e| format!("响应解析失败: {e}"))?;
        if v["code"].as_i64() == Some(0) {
            return Ok(v);
        }
        last = format!(
            "{} {}",
            v["code"].as_i64().unwrap_or(-1),
            v["message"].as_str().unwrap_or("未知错误")
        );
        if i < 4 {
            tokio::time::sleep(Duration::from_millis(800)).await;
        }
    }
    Err(format!("接口返回 {last}（已重试 4 次）"))
}

pub fn extract_bvid(input: &str) -> Result<String, String> {
    let re = Regex::new(r"BV[0-9A-Za-z]{10}").unwrap();
    re.find(input)
        .map(|m| m.as_str().to_string())
        .ok_or_else(|| "输入中没有找到合法的 BV 号".to_string())
}

// ---------- 内部数据结构（serde 序列化为 camelCase 供前端使用） ----------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub page: u64,
    pub part: String,
    pub cid: u64,
    pub duration: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeInfo {
    pub bvid: String,
    pub cid: u64,
    pub title: String,
    pub duration: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SeasonInfo {
    pub title: String,
    pub episodes: Vec<EpisodeInfo>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ViewInfo {
    pub bvid: String,
    pub title: String,
    pub owner: String,
    pub cover: String,
    pub duration: u64,
    pub pages: Vec<PageInfo>,
    pub season: Option<SeasonInfo>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamItem {
    pub key: String,
    pub id: u64,
    pub codecs: String,
    pub bandwidth: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VideoItem {
    pub codecs: String,
    pub width: u64,
    pub height: u64,
    pub bandwidth: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StreamsInfo {
    pub audio: Vec<StreamItem>,
    pub video: Vec<VideoItem>,
}

// ---------- 解析 ----------

pub async fn view(bvid: &str) -> Result<ViewInfo, String> {
    let v = bili_json(&format!(
        "https://api.bilibili.com/x/web-interface/view?bvid={bvid}"
    ))
    .await?;
    let d = &v["data"];
    let cover = d["pic"].as_str().unwrap_or_default().replacen("http:", "https:", 1);
    let pages: Vec<PageInfo> = d["pages"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|p| PageInfo {
                    page: p["page"].as_u64().unwrap_or(1),
                    part: p["part"].as_str().unwrap_or("P1").to_string(),
                    cid: p["cid"].as_u64().unwrap_or(0),
                    duration: p["duration"].as_u64().unwrap_or(0),
                })
                .collect()
        })
        .filter(|v: &Vec<PageInfo>| !v.is_empty())
        .unwrap_or_else(|| {
            vec![PageInfo {
                page: 1,
                part: d["title"].as_str().unwrap_or("P1").to_string(),
                cid: d["cid"].as_u64().unwrap_or(0),
                duration: d["duration"].as_u64().unwrap_or(0),
            }]
        });
    let season = d["ugc_season"].as_object().map(|s| SeasonInfo {
        title: s["title"].as_str().unwrap_or("合集").to_string(),
        episodes: s["sections"]
            .as_array()
            .map(|secs| {
                secs.iter()
                    .flat_map(|sec| sec["episodes"].as_array().cloned().unwrap_or_default())
                    .filter_map(|e| {
                        let bvid = e["bvid"].as_str()?.to_string();
                        let cid = e["cid"].as_u64()?;
                        Some(EpisodeInfo {
                            bvid,
                            cid,
                            title: e["title"].as_str().unwrap_or("未命名").to_string(),
                            duration: e["duration"].as_u64().unwrap_or(0),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    });
    Ok(ViewInfo {
        bvid: d["bvid"].as_str().unwrap_or(bvid).to_string(),
        title: d["title"].as_str().unwrap_or("未知标题").to_string(),
        owner: d["owner"]["name"].as_str().unwrap_or("未知 UP 主").to_string(),
        cover,
        duration: d["duration"].as_u64().unwrap_or(0),
        pages,
        season,
    })
}

/// 解析 DASH 分轨：音频轨注册进代理注册表（官方镜像候选优先），视频轨仅作展示。
pub async fn streams(bvid: &str, cid: u64) -> Result<StreamsInfo, String> {
    let v = bili_json(&format!(
        "https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&qn=64&fnval=16"
    ))
    .await?;
    let dash = &v["data"]["dash"];
    if dash.is_null() {
        return Err("该内容未返回 DASH 分轨（可能不支持或需要登录）".into());
    }
    let mut audio: Vec<StreamItem> = Vec::new();
    for s in dash["audio"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        let base = s["baseUrl"].as_str().unwrap_or_default().to_string();
        if base.is_empty() {
            continue;
        }
        let mut urls = vec![base];
        for b in s["backupUrl"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            if let Some(u) = b.as_str() {
                urls.push(u.to_string());
            }
        }
        let key = crate::proxy::register(urls, "audio");
        audio.push(StreamItem {
            key,
            id: s["id"].as_u64().unwrap_or(0),
            codecs: s["codecs"].as_str().unwrap_or("mp4a.40.2").to_string(),
            bandwidth: s["bandwidth"].as_u64().unwrap_or(0),
        });
    }
    audio.sort_by(|a, b| b.bandwidth.cmp(&a.bandwidth));
    let mut video: Vec<VideoItem> = Vec::new();
    for s in dash["video"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        video.push(VideoItem {
            codecs: s["codecs"].as_str().unwrap_or("").to_string(),
            width: s["width"].as_u64().unwrap_or(0),
            height: s["height"].as_u64().unwrap_or(0),
            bandwidth: s["bandwidth"].as_u64().unwrap_or(0),
        });
    }
    video.sort_by(|a, b| b.bandwidth.cmp(&a.bandwidth));
    if audio.is_empty() {
        return Err("未找到可用的音频轨".into());
    }
    Ok(StreamsInfo { audio, video })
}
