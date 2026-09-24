//! 收藏夹读写：登录态下的收藏夹列表 / 内容 / 新建 / 收藏视频（写回推送）。
//! 只操作用户自己的数据，量级受控（分页 20 条、逐条写回），无任何批量抓取。

use crate::bilibili::ViewInfo;
use crate::session::{self, SessionBlob};
use serde::Serialize;

fn require_session() -> Result<SessionBlob, String> {
    session::load().ok_or_else(|| "尚未登录B站账号，请先在设置中扫码登录".into())
}

fn cookie(blob: &SessionBlob) -> String {
    session::cookie_header(blob)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FavFolder {
    pub id: String,
    pub title: String,
    pub media_count: u64,
    pub private: bool,
}

pub async fn folders() -> Result<Vec<FavFolder>, String> {
    let blob = require_session()?;
    let url = format!(
        "https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid={}&type=2",
        blob.mid
    );
    let v = crate::bilibili::api_json(&url, Some(&cookie(&blob))).await?;
    let mut out = Vec::new();
    for it in v["data"]["list"].as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
        // attr 位0 = 私密收藏夹
        out.push(FavFolder {
            id: it["id"].as_u64().map(|n| n.to_string()).unwrap_or_default(),
            title: it["title"].as_str().unwrap_or("未命名收藏夹").to_string(),
            media_count: it["media_count"].as_u64().unwrap_or(0),
            private: it["attr"].as_i64().unwrap_or(0) & 1 == 1,
        });
    }
    log::info!("[fav] 收藏夹列表 n={}", out.len());
    Ok(out)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FavItem {
    pub bvid: String,
    pub title: String,
    pub up: String,
    pub page: u64, // 分P数（>1 时导入按多P展开）
    pub duration: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FavListResult {
    pub items: Vec<FavItem>,
    pub skipped_other: u32, // 音频区等暂不支持的内容
    pub skipped_invalid: u32, // 已失效视频
}

pub async fn resources(media_id: &str) -> Result<FavListResult, String> {
    let blob = require_session()?;
    let mut items = Vec::new();
    let mut skipped_other = 0u32;
    let mut skipped_invalid = 0u32;
    // ps 上限 20（接口规定）；50 页为防御性封顶，正常个人收藏夹远小于此
    for pn in 1..=50u32 {
        let url = format!(
            "https://api.bilibili.com/x/v3/fav/resource/list?media_id={media_id}&pn={pn}&ps=20&order=mtime&platform=web"
        );
        let v = crate::bilibili::api_json(&url, Some(&cookie(&blob))).await?;
        let medias = v["data"]["medias"].as_array().cloned().unwrap_or_default();
        let has_more = v["data"]["has_more"].as_bool().unwrap_or(false);
        for m in &medias {
            let bvid = m["bvid"].as_str().unwrap_or_default();
            // type: 2=视频稿件（我们只吃这类）；12=音频区（暂不支持，见调研文档 §5）
            let typ = m["type"].as_i64().unwrap_or(2);
            let attr = m["attr"].as_i64().unwrap_or(0); // 非 0 = 已失效
            if typ != 2 {
                skipped_other += 1;
                continue;
            }
            if attr != 0 || bvid.is_empty() {
                skipped_invalid += 1;
                continue;
            }
            items.push(FavItem {
                bvid: bvid.to_string(),
                title: m["title"].as_str().unwrap_or("未知标题").to_string(),
                up: m["upper"]["name"].as_str().unwrap_or_default().to_string(),
                page: m["page"].as_u64().unwrap_or(1),
                duration: m["duration"].as_u64().unwrap_or(0),
            });
        }
        if !has_more || medias.is_empty() {
            break;
        }
    }
    log::info!("[fav] 收藏夹内容 mlid={media_id} 条目={} 跳过音频/其他={skipped_other} 失效={skipped_invalid}", items.len());
    Ok(FavListResult {
        items,
        skipped_other,
        skipped_invalid,
    })
}

/// 单条写回：bvid → aid（匿名 view 解析）→ 收藏进目标收藏夹。
/// deal 幂等：已在收藏夹中的视频重复推送无副作用。
pub async fn push_one(media_id: &str, bvid: &str) -> Result<(), String> {
    let blob = require_session()?;
    let info: ViewInfo = crate::bilibili::view(bvid).await?;
    if info.aid == 0 {
        return Err("未能取得该视频的收藏标识".into());
    }
    crate::bilibili::api_form(
        "https://api.bilibili.com/x/v3/fav/resource/deal",
        &cookie(&blob),
        &[
            ("rid", info.aid.to_string()),
            ("type", "2".into()),
            ("add_media_ids", media_id.to_string()),
            ("csrf", blob.bili_jct.clone()),
        ],
    )
    .await?;
    log::info!("[fav] 写回收藏 mlid={media_id} bvid={bvid}");
    Ok(())
}

/// 新建收藏夹，返回 mlid。默认私密——听歌记录不该默认公开到个人主页。
pub async fn create_folder(title: &str, private: bool) -> Result<String, String> {
    let blob = require_session()?;
    let v = crate::bilibili::api_form(
        "https://api.bilibili.com/x/v3/fav/folder/add",
        &cookie(&blob),
        &[
            ("title", title.to_string()),
            ("privacy", if private { "1".into() } else { "0".into() }),
            ("csrf", blob.bili_jct.clone()),
        ],
    )
    .await?;
    let id = v["data"]["id"]
        .as_u64()
        .ok_or("响应缺少收藏夹 id")?
        .to_string();
    log::info!("[fav] 新建收藏夹 private={private}");
    Ok(id)
}
