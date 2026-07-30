//! End-to-end checks against a real loopback socket.
//!
//! The unit tests in `server` drive the router directly. These bind an actual
//! listener and speak real HTTP/1.1, so the origin policy, header set, cookie
//! handling, and bind behaviour are verified as a browser would meet them.

use std::io::{Read as _, Write as _};
use std::net::TcpStream;
use std::sync::Arc;

use grok_bridge::origin::LocalOrigin;
use grok_bridge::server::{HostState, bind, serve};

const INSTALL: &str = "0123456789abcdef0123456789abcdef";

fn origin_for(port: u16) -> LocalOrigin {
    LocalOrigin::new(INSTALL, port).expect("origin")
}

/// Hand out a distinct port per caller inside the Light allocatable range.
///
/// Tests run in parallel, so probing "is this port free" races: two callers
/// can observe the same free port and then collide on bind. A monotonic
/// counter gives each caller its own candidate before any probe.
fn free_port() -> u16 {
    static NEXT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(20_100);
    for _ in 0..300 {
        let port = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        assert!(port < 20_900, "exhausted the test port range");
        if std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_ok() {
            return port;
        }
    }
    panic!("no free port in the Light allocatable range");
}

struct Running {
    port: u16,
    state: Arc<HostState>,
    _task: tokio::task::JoinHandle<()>,
}

async fn start() -> Running {
    let port = free_port();
    let origin = origin_for(port);
    let state = Arc::new(HostState::new(origin.clone()));
    let listener = bind(&origin).await.expect("bind");
    let served = Arc::clone(&state);
    let task = tokio::spawn(async move {
        let _ = serve(listener, served).await;
    });
    // Give the accept loop a moment to become ready.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    Running {
        port,
        state,
        _task: task,
    }
}

/// Send a raw HTTP/1.1 request and return the full response text.
fn raw_request(port: u16, request: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("connect");
    stream.write_all(request.as_bytes()).expect("write");
    stream.flush().expect("flush");
    stream
        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .expect("timeout");
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    while let Ok(read) = stream.read(&mut chunk) {
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if buffer.windows(4).any(|w| w == b"\r\n\r\n") && buffer.len() > 64 {
            break;
        }
    }
    String::from_utf8_lossy(&buffer).into_owned()
}

fn host_header(port: u16) -> String {
    format!("{INSTALL}.grok-light.localhost:{port}")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_listener_binds_loopback_only() {
    // The bound address itself is the evidence: a routable bind would show
    // 0.0.0.0 here and would expose the host beyond this machine.
    let origin = origin_for(free_port());
    let listener = bind(&origin).await.expect("bind");
    let address = listener.local_addr().expect("local addr");
    assert!(
        address.ip().is_loopback(),
        "the host must bind loopback only, got {address}"
    );
    assert_eq!(address.port(), origin.port());
    drop(listener);

    // And a served instance answers on loopback.
    let running = start().await;
    let response = raw_request(
        running.port,
        &format!(
            "GET /healthz HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
            host_header(running.port)
        ),
    );
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "loopback must reach the host, got: {}",
        response.lines().next().unwrap_or_default()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_real_document_request_carries_every_security_header() {
    let running = start().await;
    let response = raw_request(
        running.port,
        &format!(
            "GET / HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
            host_header(running.port)
        ),
    );
    let lowered = response.to_lowercase();

    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    for expected in [
        "content-security-policy:",
        "referrer-policy: no-referrer",
        "x-content-type-options: nosniff",
        "cross-origin-opener-policy: same-origin",
        "cache-control: no-store",
        "permissions-policy:",
    ] {
        assert!(
            lowered.contains(expected),
            "missing header {expected} in:\n{response}"
        );
    }
    assert!(
        lowered.contains("connect-src 'self'"),
        "the loopback origin must not need a widened connect-src"
    );
    assert!(
        lowered.contains("frame-ancestors 'none'"),
        "the document must refuse framing"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_foreign_host_header_is_refused_over_a_real_socket() {
    let running = start().await;
    for host in ["localhost", "127.0.0.1", "evil.example"] {
        let response = raw_request(
            running.port,
            &format!("GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"),
        );
        assert!(
            response.starts_with("HTTP/1.1 403"),
            "host {host} must be refused, got: {}",
            response.lines().next().unwrap_or_default()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unpaired_command_is_refused_over_a_real_socket() {
    let running = start().await;
    let host = host_header(running.port);
    let body = r#"{"protocolVersion":1,"requestId":"req-1","operation":{"kind":"bootstrap"}}"#;
    let response = raw_request(
        running.port,
        &format!(
            "POST /command HTTP/1.1\r\nHost: {host}\r\nOrigin: http://{host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ),
    );
    assert!(
        response.starts_with("HTTP/1.1 403"),
        "an unpaired command must be refused, got: {}",
        response.lines().next().unwrap_or_default()
    );
}

/// Pair a browser the way the SPA does, returning its cookie and CSRF token.
async fn pair(running: &Running) -> (String, String) {
    let host = host_header(running.port);
    let nonce = {
        let mut broker = running.state.pairing.lock().await;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX));
        broker.mint_nonce(now).expect("mint").expose().to_owned()
    };

    let pair_body = format!(r#"{{"nonce":"{nonce}"}}"#);
    let pair_response = raw_request(
        running.port,
        &format!(
            "POST /pair HTTP/1.1\r\nHost: {host}\r\nOrigin: http://{host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{pair_body}",
            pair_body.len()
        ),
    );
    assert!(pair_response.starts_with("HTTP/1.1 200"), "{pair_response}");
    assert!(
        pair_response.to_lowercase().contains("httponly"),
        "the pairing cookie must be HttpOnly"
    );
    assert!(
        pair_response.to_lowercase().contains("samesite=strict"),
        "the pairing cookie must be SameSite=Strict"
    );

    let cookie = pair_response
        .lines()
        .find(|line| line.to_lowercase().starts_with("set-cookie:"))
        .and_then(|line| line.split_once(": "))
        .and_then(|(_, value)| value.split(';').next())
        .expect("cookie")
        .to_owned();
    let csrf = pair_response
        .rsplit_once("\r\n\r\n")
        .map(|(_, body)| body)
        .and_then(|body| serde_json::from_str::<serde_json::Value>(body.trim()).ok())
        .and_then(|json| {
            json.get("csrfToken")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
        })
        .expect("csrf token");
    (cookie, csrf)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_paired_browser_can_issue_a_command_over_a_real_socket() {
    let running = start().await;
    let host = host_header(running.port);
    let (cookie, csrf) = pair(&running).await;

    let body = r#"{"protocolVersion":2,"requestId":"req-1","operation":{"kind":"bootstrap"}}"#;
    let response = raw_request(
        running.port,
        &format!(
            "POST /command HTTP/1.1\r\nHost: {host}\r\nOrigin: http://{host}\r\nCookie: {cookie}\r\nx-grok-light-csrf: {csrf}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ),
    );
    assert!(
        response.starts_with("HTTP/1.1 202"),
        "a paired command must be accepted, got: {}",
        response.lines().next().unwrap_or_default()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_bind_on_the_same_port_fails() {
    let running = start().await;
    let origin = origin_for(running.port);
    let second = bind(&origin).await;
    assert!(
        second.is_err(),
        "a second host must not be able to share the canonical port"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_tab_that_outlived_an_upgrade_is_told_to_reload() {
    // The SPA is served by the host, so the only way to see an older protocol
    // version is a tab left open across an upgrade. Its command body may no
    // longer parse at all, so the version has to be answered on its own terms
    // rather than as a malformed request the user cannot act on.
    let running = start().await;
    let host = host_header(running.port);
    let (cookie, csrf) = pair(&running).await;

    let body = r#"{"protocolVersion":99,"requestId":"req-1","operation":{"kind":"loadSession","sessionId":"s-1"}}"#;
    let response = raw_request(
        running.port,
        &format!(
            "POST /command HTTP/1.1\r\nHost: {host}\r\nOrigin: http://{host}\r\nCookie: {cookie}\r\nx-grok-light-csrf: {csrf}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ),
    );

    assert!(
        response.starts_with("HTTP/1.1 409"),
        "a stale client must be answered distinctly, got: {}",
        response.lines().next().unwrap_or_default()
    );
    assert!(
        response.contains("unsupported_protocol_version"),
        "the answer must name the reason so the SPA can prompt a reload"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn asking_the_host_to_stop_actually_stops_it() {
    // Answering the control socket is not stopping. A host that replied and
    // kept running would hold the port and the state directory against a user
    // who believed they had ended it.
    let port = free_port();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .expect("bind");
    let state = Arc::new(HostState::new(origin_for(port)));

    let serving = tokio::spawn({
        let state = Arc::clone(&state);
        async move { grok_bridge::server::serve(listener, state).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    state.request_shutdown();

    let stopped = tokio::time::timeout(std::time::Duration::from_secs(5), serving).await;
    assert!(
        stopped.is_ok(),
        "the host must stop serving after a shutdown request"
    );
}
