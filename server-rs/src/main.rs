//! aghorizon-server-rs [port]   (port 0 = any free port; default 47831)
//! Prints "READY <port>" or "ERROR <code> <message>" (then exits with 1), as sidecar/entry.js does, and exits when
//! its stdin closes (unless AGH_NO_STDIN_WATCH), so it can't outlive the app that started it.

#[tokio::main]
async fn main() {
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(47831);
    let cfg = aghorizon_server::Config::from_env();
    match aghorizon_server::start(cfg, port).await {
        Ok((port, task)) => {
            println!("READY {port}");
            if std::env::var_os("AGH_NO_STDIN_WATCH").is_none() {
                tokio::spawn(async {
                    use tokio::io::AsyncReadExt;
                    let mut stdin = tokio::io::stdin();
                    let mut buf = [0u8; 4096];
                    loop {
                        match stdin.read(&mut buf).await {
                            Ok(0) | Err(_) => std::process::exit(0), // the app went away
                            Ok(_) => {}                              // the RPC lines come in a later step of Phase 8
                        }
                    }
                });
            }
            let _ = task.await;
        }
        Err(e) => {
            let code = match e.kind() {
                std::io::ErrorKind::AddrInUse => "EADDRINUSE",
                std::io::ErrorKind::PermissionDenied => "EACCES",
                _ => "START",
            };
            println!("ERROR {code} {e}");
            std::process::exit(1);
        }
    }
}
