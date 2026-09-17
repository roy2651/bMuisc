//! 受限的 Tauri Commands：前端访问原生能力的唯一入口。

use crate::bilibili;

#[tauri::command]
pub async fn resolve_view(input: String) -> Result<bilibili::ViewInfo, String> {
    let bvid = bilibili::extract_bvid(&input)?;
    bilibili::view(&bvid).await
}

#[tauri::command]
pub async fn resolve_streams(bvid: String, cid: u64) -> Result<bilibili::StreamsInfo, String> {
    bilibili::streams(&bvid, cid).await
}

#[tauri::command]
pub async fn proxy_port() -> Result<u16, String> {
    let port = crate::proxy::port();
    if port == 0 {
        return Err("媒体代理尚未就绪，请稍候重试".into());
    }
    Ok(port)
}
