//! WebSocket event channel checks against a real loopback socket.
//!
//! The upgrade path cannot be exercised through a `oneshot` router call,
//! because the extractor needs a connection that is genuinely upgradable.
//! These tests open real sockets so the subprotocol, cookie, and control-lease
//! rules are verified as a browser would meet them.

use std::sync::Arc;

use grok_bridge::lease::LeaseState;
use grok_bridge::origin::LocalOrigin;
use grok_bridge::protocol::WS_SUBPROTOCOL;
use grok_bridge::server::{HostState, bind, serve};
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::http::header;

const INSTALL: &str = "0123456789abcdef0123456789abcdef";

fn free_port() -> u16 {
    static NEXT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(21_100);
    for _ in 0..300 {
        let port = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        assert!(port < 21_900, "exhausted the test port range");
        if std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_ok() {
            return port;
        }
    }
    panic!("no free port");
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

struct Running {
    port: u16,
    state: Arc<HostState>,
    _task: tokio::task::JoinHandle<()>,
}

impl Running {
    fn host(&self) -> String {
        format!("{INSTALL}.grok-light.localhost:{}", self.port)
    }

    fn origin(&self) -> String {
        format!("http://{}", self.host())
    }

    fn events_url(&self) -> String {
        format!("ws://{}/events", self.host())
    }
}

async fn start() -> Running {
    let port = free_port();
    let origin = LocalOrigin::new(INSTALL, port).expect("origin");
    let state = Arc::new(HostState::new(origin.clone()));
    let listener = bind(&origin).await.expect("bind");
    let served = Arc::clone(&state);
    let task = tokio::spawn(async move {
        let _ = serve(listener, served).await;
    });
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    Running {
        port,
        state,
        _task: task,
    }
}

/// Pair a browser directly against host state and return its cookie value.
async fn pair(running: &Running) -> String {
    let mut broker = running.state.pairing.lock().await;
    let nonce = broker
        .mint_nonce(now_ms())
        .expect("mint")
        .expose()
        .to_owned();
    let paired = broker.redeem_nonce(&nonce, now_ms()).expect("redeem");
    format!("gl_session={}", paired.session_token.expose())
}

/// Attempt an events upgrade with the supplied headers.
async fn connect(
    running: &Running,
    cookie: Option<&str>,
    protocol: Option<&str>,
) -> Result<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    tokio_tungstenite::tungstenite::Error,
> {
    let mut request = running.events_url().into_client_request().expect("request");
    let headers = request.headers_mut();
    headers.insert(
        header::ORIGIN,
        running.origin().parse().expect("origin header"),
    );
    if let Some(cookie) = cookie {
        headers.insert(header::COOKIE, cookie.parse().expect("cookie header"));
    }
    if let Some(protocol) = protocol {
        headers.insert(
            header::SEC_WEBSOCKET_PROTOCOL,
            protocol.parse().expect("protocol header"),
        );
    }
    tokio_tungstenite::connect_async(request)
        .await
        .map(|(stream, _)| stream)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_paired_browser_with_the_exact_subprotocol_connects() {
    let running = start().await;
    let cookie = pair(&running).await;
    let socket = connect(&running, Some(&cookie), Some(WS_SUBPROTOCOL)).await;
    assert!(socket.is_ok(), "upgrade must succeed: {:?}", socket.err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upgrade_without_the_subprotocol_is_refused() {
    let running = start().await;
    let cookie = pair(&running).await;
    let socket = connect(&running, Some(&cookie), None).await;
    assert!(
        socket.is_err(),
        "an upgrade without the versioned subprotocol must be refused"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upgrade_with_a_wrong_subprotocol_is_refused() {
    let running = start().await;
    let cookie = pair(&running).await;
    let socket = connect(&running, Some(&cookie), Some("light.local.v2")).await;
    assert!(socket.is_err(), "a version mismatch must be refused");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_unpaired_upgrade_is_refused() {
    let running = start().await;
    let socket = connect(&running, None, Some(WS_SUBPROTOCOL)).await;
    assert!(
        socket.is_err(),
        "an upgrade without a paired cookie must be refused"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connecting_takes_the_control_lease() {
    let running = start().await;
    let cookie = pair(&running).await;

    {
        let lease = running.state.lease.lock().await;
        assert_eq!(lease.state(now_ms()), LeaseState::Vacant);
    }

    let _socket = connect(&running, Some(&cookie), Some(WS_SUBPROTOCOL))
        .await
        .expect("upgrade");
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;

    let lease = running.state.lease.lock().await;
    assert_eq!(
        lease.state(now_ms()),
        LeaseState::Held,
        "the first connection must hold the control lease"
    );
    assert!(lease.epoch() >= 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_second_tab_cannot_take_control_from_a_live_one() {
    let running = start().await;
    let cookie = pair(&running).await;

    let _first = connect(&running, Some(&cookie), Some(WS_SUBPROTOCOL))
        .await
        .expect("first upgrade");
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    let epoch_after_first = running.state.lease.lock().await.epoch();

    // A second tab of the same browser session: the upgrade itself succeeds,
    // but it must not become the controller.
    let _second = connect(&running, Some(&cookie), Some(WS_SUBPROTOCOL))
        .await
        .expect("second upgrade");
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    let lease = running.state.lease.lock().await;
    assert_eq!(
        lease.epoch(),
        epoch_after_first,
        "a second tab must not acquire a new controller epoch while the first is live"
    );
    assert_eq!(lease.state(now_ms()), LeaseState::Held);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn losing_the_controller_interrupts_work_in_flight() {
    let running = start().await;
    let cookie = pair(&running).await;

    let socket = connect(&running, Some(&cookie), Some(WS_SUBPROTOCOL))
        .await
        .expect("upgrade");
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;

    // Something is dispatched and never confirmed.
    {
        let mut journal = running.state.journal.lock().await;
        journal.begin("prompt-1", "Prompt", Some("s-1"));
        assert!(journal.pending_reviews().is_empty());
    }

    drop(socket);
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    let journal = running.state.journal.lock().await;
    let pending = journal.pending_reviews();
    assert_eq!(
        pending.len(),
        1,
        "losing the controlling tab must open a review record"
    );
    assert_eq!(pending[0].operation, "Prompt");
    assert!(
        !pending[0].acknowledged,
        "the record must await explicit human review"
    );
}
