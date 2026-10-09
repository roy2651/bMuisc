// Windows 托盘：关窗 = 隐藏到托盘继续运行（播放不中断），唯一退出入口是
// 托盘右键菜单的「退出」。macOS 不装托盘——关窗本就是隐藏（tao 默认），
// Dock 图标负责恢复（lib.rs RunEvent::Reopen）。
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter,
};

pub fn init(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let mini = MenuItem::with_id(app, "mini", "迷你播放器", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &mini, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("bundle 内置图标缺失").clone())
        .tooltip("bMuisc")
        .menu(&menu)
        // 左键 = 恢复窗口（Windows 惯例），右键才弹菜单
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            // 进迷你模式：只向主窗转发请求——建窗/握手/藏主窗的完整流程
            // 在主窗 webview 的 enterMini 里（回调里建窗会死锁，wry#583）。
            // 广播而非 emit_to：mini 不监听此事件，主窗的 Any 监听器必然收到
            "mini" => {
                let _ = app.emit("mini:enter", ());
            }
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

// 所有恢复入口走同一原生模式切换，取消迟到的进入请求。
fn show_main(app: &tauri::AppHandle) {
    crate::mini::show_main(app);
}
