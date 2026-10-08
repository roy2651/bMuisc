//! 受限的 Tauri Commands：前端访问原生能力的唯一入口。

use crate::{bilibili, fav, session};

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

// ---------- 账号 / 收藏夹（凭证只在 Rust 侧，前端只见展示信息） ----------

#[tauri::command]
pub async fn login_qr_generate(attempt_id: String) -> Result<session::QrStart, String> {
    session::qr_generate(&attempt_id).await
}

#[tauri::command]
pub async fn login_qr_poll(qrcode_key: String, epoch: u64) -> Result<session::PollDto, String> {
    session::qr_poll(&qrcode_key, epoch).await
}

/// 关闭扫码弹窗等放弃登录的路径：按尝试 ID 定向作废在途登录——旧弹窗迟到的
/// 取消不会影响新弹窗已开始的登录（无差别换代会误杀，复审 P2-①）
#[tauri::command]
pub async fn login_qr_cancel(attempt_id: String) {
    session::cancel_attempt(&attempt_id);
}

#[tauri::command]
pub async fn login_state() -> Result<session::StateDto, String> {
    Ok(session::state_dto())
}

#[tauri::command]
pub async fn login_logout() -> Result<(), String> {
    session::delete()?;
    log::info!("[session] 已登出并清除本机凭证");
    Ok(())
}

#[tauri::command]
pub async fn fav_folders() -> Result<Vec<fav::FavFolder>, String> {
    fav::folders().await
}

#[tauri::command]
pub async fn fav_resources(media_id: String) -> Result<fav::FavListResult, String> {
    fav::resources(&media_id).await
}

#[tauri::command]
pub async fn fav_push(media_id: String, bvid: String) -> Result<(), String> {
    fav::push_one(&media_id, &bvid).await
}

#[tauri::command]
pub async fn fav_create_folder(title: String, private: bool) -> Result<String, String> {
    fav::create_folder(&title, private).await
}
