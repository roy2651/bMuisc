pub mod bilibili; // pub 供集成测试（tests/）直接验证解析链路
mod commands;
mod proxy;
#[cfg(windows)]
mod tray;

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
        .on_window_event(|window, event| {
            // Windows 关窗 = 藏到托盘继续运行（播放不中断），唯一退出在托盘菜单；
            // macOS 不拦：tao 默认关窗即隐藏，Dock 图标恢复（RunEvent::Reopen）
            #[cfg(windows)]
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            #[cfg(not(windows))]
            let _ = (window, event);
        })
        .setup(|app| {
            // 自动更新插件（仅桌面端编译，依赖也按桌面 target 划分）：
            // 检查与下载都在 Rust 侧进行，更新入口由前端按平台自行 gating
            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            // 文件日志：stdout + 系统日志目录 + webview 控制台三路输出。
            // macOS: ~/Library/Logs/com.roy2651.bmuisc/bmuisc.log
            // Windows: %LOCALAPPDATA%\com.roy2651.bmuisc\logs\bmuisc.log
            // 磁盘占用硬封顶：单文件 64KB，写满 KeepOne 轮转（删旧档重来），
            // 永不打满磁盘；只记低频状态事件（播放/切歌/系统指令），不记进度流。
            #[cfg(desktop)]
            app.handle().plugin(
                tauri_plugin_log::Builder::new()
                    .level(tauri_plugin_log::log::LevelFilter::Info)
                    .max_file_size(64 * 1024)
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepOne)
                    .targets([
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                            file_name: Some("bmuisc".into()),
                        }),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview),
                    ])
                    .build(),
            )?;
            // Windows 托盘（关窗=隐藏，退出走托盘菜单，见 tray.rs）
            #[cfg(windows)]
            tray::init(app)?;
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
