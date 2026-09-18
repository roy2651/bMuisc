pub mod bilibili; // pub 供集成测试（tests/）直接验证解析链路
mod commands;
mod proxy;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 第二实例启动时立即退出，转由这里把已有窗口带到前台（macOS 关窗后是隐藏，需要先 show）
            use tauri::Manager;
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
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
        .build(tauri::generate_context!())
        .expect("bMuisc 启动失败")
        .run(|app, event| {
            // macOS 点 Dock 图标：把隐藏的窗口重新显示（关窗只是 hide，应用仍在运行）
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (&app, &event);
        });
}
