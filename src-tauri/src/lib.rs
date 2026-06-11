use std::io::Read;
use std::thread;

use tauri::{AppHandle, Emitter};

const DEFAULT_PORT: u16 = 6767;

/// States accepted on POST /state and forwarded to the webview.
const VALID_STATES: &[&str] = &["needs_input", "working", "done", "idle"];

fn spawn_state_server(app: AppHandle) {
    let port: u16 = std::env::var("W0RM_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_PORT);

    thread::spawn(move || {
        let server = match tiny_http::Server::http(("127.0.0.1", port)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("w0rm: failed to bind 127.0.0.1:{port}: {e}");
                return;
            }
        };
        println!("w0rm: state server listening on 127.0.0.1:{port}");

        for mut request in server.incoming_requests() {
            let mut body = String::new();
            let _ = request.as_reader().take(4096).read_to_string(&mut body);

            let (status, reply) = match (request.method().as_str(), request.url()) {
                ("POST", "/state") => {
                    let state = serde_json::from_str::<serde_json::Value>(&body)
                        .ok()
                        .and_then(|v| v.get("state").and_then(|s| s.as_str()).map(String::from));
                    match state {
                        Some(s) if VALID_STATES.contains(&s.as_str()) => {
                            let _ = app.emit("claude-state", &s);
                            (200, "ok".to_string())
                        }
                        Some(s) => (400, format!("unknown state '{s}'")),
                        None => (400, "expected JSON body {\"state\": \"...\"}".to_string()),
                    }
                }
                ("GET", "/health") => (200, "ok".to_string()),
                _ => (404, "not found".to_string()),
            };

            let _ = request.respond(
                tiny_http::Response::from_string(reply).with_status_code(status),
            );
        }
    });
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![quit])
        .setup(|app| {
            // The pet should not steal focus or show up in the dock.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            spawn_state_server(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
