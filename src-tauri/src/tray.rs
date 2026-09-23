// Windows 托盘：关窗 = 隐藏到托盘继续运行（播放不中断），唯一退出入口是
// 托盘右键菜单的「退出」。macOS 不装托盘——关窗本就是隐藏（tao 默认），
// Dock 图标负责恢复（lib.rs RunEvent::Reopen）。
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

pub fn init(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("bundle 内置图标缺失").clone())
        .tooltip("bMuisc")
        .menu(&menu)
        // 左键 = 恢复窗口（Windows 惯例），右键才弹菜单
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0), // 唯一真退出：关窗只是藏
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

// 显示并聚焦主窗（托盘左键 / 菜单项共用；第二实例启动的同款逻辑在
// single-instance 回调里，那边 mac 也要用，不跨平台共享这个模块）
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
