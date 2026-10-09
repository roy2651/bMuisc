// 主窗是唯一播放控制器；副窗只负责展示与操作转发。
// 创建在后台线程执行（wry#583），所有可见性切换在 UI 线程串行执行。
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const MINI_LABEL: &str = "mini";
static MINI_CREATE: Mutex<()> = Mutex::new(());
struct Pending {
    id: String,
    expires: Instant,
}
static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

fn pending_is(request_id: &str) -> bool {
    PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|p| p.id == request_id && Instant::now() < p.expires)
}

// 只在 UI 线程调用；requestId 同时是进入请求的代际，离开即作废。
fn invalidate(app: &AppHandle) {
    let old = PENDING.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(id) = old {
        let _ = app.emit("mini:cancelled", id.id);
    }
}

async fn on_ui<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(action(&handle));
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "窗口操作已中断".to_string())?
}

fn ensure_mini(app: &AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let _gate = MINI_CREATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(w) = app.get_webview_window(MINI_LABEL) {
        return Ok(w);
    }
    let builder = WebviewWindowBuilder::new(app, MINI_LABEL, WebviewUrl::App("mini.html".into()))
        .title("bMuisc 迷你播放器")
        .inner_size(340.0, 90.0)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        // 保留现有鼠标不抢焦点行为；键盘访问仍需后续平台验证。
        .focusable(false)
        .visible(false);
    // 迷你入口当前仅 Windows 开放；macOS 的 transparent API 需要 macos-private-api。
    // 共用模块仍会在 macOS 编译，因此将透明配置限制在已支持的平台。
    #[cfg(windows)]
    let builder = builder.transparent(true);
    builder.build()
}

/// 启动预建只创建隐藏窗口，不改变窗口模式。
pub fn preload(app: &AppHandle) -> tauri::Result<()> {
    ensure_mini(app).map(|_| ())
}

/// 在任何前端监听/建窗等待之前登记；原生期限也拒绝过期提交。
#[tauri::command]
pub async fn mini_begin_enter(app: AppHandle, request_id: String) -> Result<(), String> {
    let expires = Instant::now() + Duration::from_secs(5);
    on_ui(&app, move |app| {
        invalidate(app);
        *PENDING.lock().unwrap_or_else(|e| e.into_inner()) = Some(Pending {
            id: request_id,
            expires,
        });
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn mini_show(app: AppHandle, request_id: String) -> Result<bool, String> {
    if !pending_is(&request_id) {
        return Ok(false);
    }
    let handle = app.clone();
    let created = tauri::async_runtime::spawn_blocking(move || ensure_mini(&handle).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string());
    created?;
    let id = request_id.clone();
    let active = on_ui(&app, move |app| {
        if !pending_is(&id) {
            return Ok(false);
        }
        app.emit("mini:activate", &id).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await?;
    if active {
        // 预建窗口也可能尚未装好监听。补发绑定本次请求，提交/退出后立即停止。
        tauri::async_runtime::spawn(async move {
            for _ in 0..20 {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                let id = request_id.clone();
                let result = on_ui(&app, move |app| {
                    if !pending_is(&id) {
                        return Ok(false);
                    }
                    app.emit("mini:activate", &id).map_err(|e| e.to_string())?;
                    Ok(true)
                })
                .await;
                if !matches!(result, Ok(true)) {
                    break;
                }
            }
        });
    }
    Ok(active)
}

#[tauri::command]
pub async fn mini_cancel_enter(app: AppHandle, request_id: String) -> Result<(), String> {
    on_ui(&app, move |app| {
        // 清理只按 ID 匹配；过期请求也应释放，不影响之后的新请求。
        let matches = PENDING
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|p| p.id == request_id);
        if matches {
            invalidate(app);
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn mini_commit_enter(app: AppHandle, request_id: String) -> Result<bool, String> {
    on_ui(&app, move |app| {
        if !pending_is(&request_id) {
            return Ok(false);
        }
        // 一次请求只允许提交一次；此闭包内没有异步让出，与所有恢复入口串行。
        PENDING.lock().unwrap_or_else(|e| e.into_inner()).take();
        let main = app.get_webview_window("main").ok_or("主窗口不存在")?;
        let mini = app.get_webview_window(MINI_LABEL).ok_or("迷你窗口不存在")?;
        mini.show().map_err(|e| e.to_string())?;
        if let Err(e) = main.hide() {
            let _ = mini.hide(); // 主窗隐藏失败则回退，避免两窗持续同显
            return Err(e.to_string());
        }
        Ok(true)
    })
    .await
}

fn restore_main(app: &AppHandle) -> Result<(), String> {
    invalidate(app);
    let main = app.get_webview_window("main").ok_or("主窗口不存在")?;
    main.unminimize().map_err(|e| e.to_string())?;
    main.show().map_err(|e| e.to_string())?;
    if let Some(mini) = app.get_webview_window(MINI_LABEL) {
        mini.hide().map_err(|e| e.to_string())?;
    }
    main.set_focus().map_err(|e| e.to_string())
}

/// 托盘、第二实例、Dock 共用。回调只投递 UI 操作，不在此创建窗口。
pub fn show_main(app: &AppHandle) {
    let handle = app.clone();
    if let Err(e) = app.run_on_main_thread(move || {
        if let Err(e) = restore_main(&handle) {
            log::warn!("恢复主窗口失败: {e}");
        }
    }) {
        log::warn!("调度主窗口恢复失败: {e}");
    }
}

/// 系统关窗进入后台时，也作废尚未提交的迷你请求。
#[cfg(windows)]
pub fn hide_window(app: &AppHandle, label: &str) {
    let handle = app.clone();
    let label = label.to_string();
    let _ = app.run_on_main_thread(move || {
        invalidate(&handle);
        if let Some(w) = handle.get_webview_window(&label) {
            let _ = w.hide();
        }
    });
}

#[tauri::command]
pub async fn mini_expand(app: AppHandle) -> Result<(), String> {
    on_ui(&app, restore_main).await
}

// 保留本次实现中 X 返回主窗口的行为，统一作废在途请求。
#[tauri::command]
pub async fn mini_close(app: AppHandle) -> Result<(), String> {
    on_ui(&app, restore_main).await
}
