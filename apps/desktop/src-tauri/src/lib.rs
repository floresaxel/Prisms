//! Prisms desktop shell. Loads the identical web build (frontendDist) into a
//! Tauri v2 WebView — PowerSync persists via the web SDK (wa-sqlite/OPFS) in
//! that WebView — and registers the notification plugin so the web layer's
//! `osNotify()` surfaces as native OS notifications (§12.3).

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .run(tauri::generate_context!())
        .expect("error while running the Prisms desktop app");
}
