pub mod bilibili; // pub 供集成测试（tests/）直接验证解析链路
mod commands;
mod proxy;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_| {
            tauri::async_runtime::spawn(async {
                if let Err(e) = proxy::spawn().await {
                    eprintln!("本地媒体代理启动失败: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::resolve_view,
            commands::resolve_streams,
            commands::proxy_port
        ])
        .run(tauri::generate_context!())
        .expect("bMuisc 启动失败");
}
