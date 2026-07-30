//! `grok-bridge` — the local host and its launcher.
//!
//! Subcommands:
//!
//! - `serve`  — run the host in the foreground.
//! - `open`   — mint a pairing nonce from a running host and print its URL.
//! - `status` — report whether a host is running and whether it is paired.
//! - `doctor` — check the qualified CLI, the state directory, and the port.
//! - `stop`   — ask a running host to shut down.
//! - `repair` — rotate origin and pairings. Explicit and destructive to the
//!   existing bookmark, which is why a busy port never reaches it.
//!
//! Visiting an HTTP URL can never start a stopped host: only this binary can,
//! and only through the owner-only control socket.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use grok_bridge::acp::{AgentCommand, AgentHandle};
use grok_bridge::control::{self, ControlRequest, ControlResponse};
use grok_bridge::instance::{InstanceLock, ensure_private_directory};
use grok_bridge::server::{HostState, bind, serve};
use grok_bridge::state;
use grok_bridge::workspace;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let command = args.next().unwrap_or_else(|| "help".to_owned());

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("grok-bridge: could not start the async runtime: {error}");
            return ExitCode::FAILURE;
        }
    };

    let outcome = runtime.block_on(async {
        match command.as_str() {
            "serve" => run_serve().await,
            "open" => run_open().await,
            "status" => run_status().await,
            "doctor" => run_doctor().await,
            "stop" => run_stop().await,
            "repair" => run_repair().await,
            "workspace" => run_workspace(&args.collect::<Vec<_>>()),
            "help" | "--help" | "-h" => {
                print_help();
                Ok(())
            }
            other => Err(format!(
                "unknown command `{other}`. Try `grok-bridge help`."
            )),
        }
    });

    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("grok-bridge: {message}");
            ExitCode::FAILURE
        }
    }
}

fn print_help() {
    println!(
        "grok-bridge — local host for the Grok Build CLI

USAGE:
  grok-bridge <command>

COMMANDS:
  serve     Run the host in the foreground
  open      Mint a pairing nonce and print the URL to open
  status    Report host and pairing state
  doctor    Check the qualified CLI, state directory, and port
  stop      Ask a running host to shut down
  repair    Rotate the origin and every pairing (invalidates the bookmark)

  workspace add <path>     Enrol a directory the agent may work in
  workspace list           List enrolled workspaces
  workspace remove <id>    Forget an enrolment

Grok Desktop Portable drives the Grok Build CLI you already installed, with your own
configuration and your own authority. It is a control surface, not a sandbox."
    );
}

/// Locate the qualified Grok Build CLI.
///
/// Light drives the CLI the user installed; it never ships or downloads one.
/// The web surface can never influence this, per light ADR 0005.
fn resolve_agent() -> Result<AgentCommand, String> {
    let program = std::env::var("GROK_BRIDGE_AGENT").unwrap_or_else(|_| "grok".to_owned());
    let probe = std::process::Command::new(&program)
        .arg("--version")
        .output()
        .map_err(|_| {
            format!("`{program}` was not found. Install and authenticate the Grok Build CLI first.")
        })?;
    if !probe.status.success() {
        return Err(format!(
            "`{program} --version` failed; the CLI is not usable."
        ));
    }
    Ok(AgentCommand::new(program))
}

/// Owner-only state directory for this user.
///
/// Order: `GROK_BRIDGE_STATE_DIR`, then platform default. The wire protocol and
/// origin hostname still use the historical `light` names in v0 so existing
/// bookmarks and sessions keep working for early testers.
fn state_directory() -> Result<PathBuf, String> {
    if let Ok(explicit) = std::env::var("GROK_BRIDGE_STATE_DIR") {
        return Ok(PathBuf::from(explicit));
    }
    // Compatibility for developers who already used the in-monorepo name.
    if let Ok(legacy) = std::env::var("GROK_LIGHT_STATE_DIR") {
        return Ok(PathBuf::from(legacy));
    }
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("LOCALAPPDATA")
            .map(PathBuf::from)
            .map_err(|_| "LOCALAPPDATA is not set".to_owned())?;
        Ok(base.join("grok-bridge"))
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").map_err(|_| "HOME is not set".to_owned())?;
        Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("grok-bridge"))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let base = std::env::var("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|_| {
                std::env::var("HOME").map(|home| PathBuf::from(home).join(".local").join("state"))
            })
            .map_err(|_| "neither XDG_STATE_HOME nor HOME is set".to_owned())?;
        Ok(base.join("grok-bridge"))
    }
}

async fn run_serve() -> Result<(), String> {
    let directory = state_directory()?;
    let lock = InstanceLock::acquire(&directory).map_err(|error| error.to_string())?;
    let identity = state::load_or_create(lock.directory()).map_err(|error| error.to_string())?;
    let origin = identity.origin().map_err(|error| error.to_string())?;

    let listener = bind(&origin).await.map_err(|error| {
        format!(
            "port {} is unavailable ({error}). This is transient: the origin and \
             pairings are kept. Retry, or run `grok-bridge repair` to rotate them.",
            origin.port()
        )
    })?;
    // On Linux the picker is the desktop portal; elsewhere it is honestly
    // unavailable rather than silently accepting a browser-supplied path.
    #[cfg(target_os = "linux")]
    let picker: Arc<dyn grok_bridge::picker::DirectoryPicker> =
        Arc::new(grok_bridge::picker::PortalDirectoryPicker);
    #[cfg(not(target_os = "linux"))]
    let picker: Arc<dyn grok_bridge::picker::DirectoryPicker> =
        Arc::new(grok_bridge::picker::UnavailableDirectoryPicker);

    let state = Arc::new(
        HostState::new(origin.clone())
            .with_persistence(lock.directory().to_path_buf(), picker)
            .map_err(|error| format!("journal is unusable: {error}"))?,
    );

    // The enrolments are durable and host-owned; the browser only receives
    // their opaque ids.
    let index = workspace::load(lock.directory()).map_err(|error| error.to_string())?;
    state.load_workspaces(&index).await;

    // The agent starts on demand, not at login: opening the interface must not
    // spawn a Grok process by itself.
    match resolve_agent() {
        Ok(command) => match AgentHandle::spawn(&command) {
            Ok((agent, events)) => {
                if agent.initialize().await.is_ok() {
                    state.attach_agent(agent, events);
                } else {
                    eprintln!(
                        "grok-bridge: the Grok Build CLI did not complete the ACP handshake; \
                         sessions are unavailable until it does"
                    );
                }
            }
            Err(error) => eprintln!("grok-bridge: could not start the Grok Build CLI: {error}"),
        },
        Err(message) => eprintln!("grok-bridge: {message}"),
    }

    let control_listener = control::bind(lock.directory()).map_err(|error| error.to_string())?;
    let control_state = Arc::clone(&state);
    tokio::spawn(async move { control::serve(control_listener, control_state).await });

    println!("grok-bridge listening on {origin}");
    println!("run `grok-bridge open` in this account to pair a browser");
    serve(listener, state)
        .await
        .map_err(|error| error.to_string())
}

async fn run_open() -> Result<(), String> {
    let directory = state_directory()?;
    match control::call(&directory, &ControlRequest::MintNonce).await {
        Ok(ControlResponse::Paired { url, .. }) => {
            println!("{url}");
            println!(
                "\nOpen that URL once to pair this browser, then bookmark the address \
                 without the fragment."
            );
            Ok(())
        }
        Ok(ControlResponse::Error { code }) => Err(format!("host refused to pair: {code}")),
        Ok(other) => Err(format!("unexpected response: {other:?}")),
        Err(error) => Err(format!(
            "{error}. Start one with `grok-bridge serve` — visiting the URL cannot \
             start a stopped host."
        )),
    }
}

async fn run_status() -> Result<(), String> {
    let directory = state_directory()?;
    match control::call(&directory, &ControlRequest::Status).await {
        Ok(ControlResponse::Status {
            origin,
            paired,
            controlled,
        }) => {
            println!("running   {origin}");
            println!("paired    {}", if paired { "yes" } else { "no" });
            println!("in use    {}", if controlled { "yes" } else { "no" });
            Ok(())
        }
        Ok(other) => Err(format!("unexpected response: {other:?}")),
        Err(_) => {
            println!("running   no");
            Ok(())
        }
    }
}

async fn run_doctor() -> Result<(), String> {
    let directory = state_directory()?;
    println!("state dir  {}", directory.display());
    if let Err(error) = ensure_private_directory(&directory) {
        println!("state dir  unusable: {error}");
    }

    match state::load_or_create(&directory) {
        Ok(identity) => {
            println!("install id {}", identity.install_id);
            println!("port       {}", identity.port);
            match identity.origin() {
                Ok(origin) => println!("origin     {origin}"),
                Err(error) => println!("origin     unusable: {error}"),
            }
        }
        Err(error) => println!("identity   unusable: {error}"),
    }

    // Product integrity floor (light ADR 0005): report the install against the
    // qualified matrix. This is support diagnostics, not a security boundary.
    use grok_bridge::cli_matrix::{self, CliQualification, MIN_QUALIFIED_CLI_LABEL};
    match cli_matrix::qualify_default() {
        CliQualification::Known {
            version,
            meets_minimum,
        } if meets_minimum => {
            println!("grok cli   {version} (qualified, min {MIN_QUALIFIED_CLI_LABEL})");
        }
        CliQualification::Known { version, .. } => {
            println!("grok cli   {version} — below qualified minimum {MIN_QUALIFIED_CLI_LABEL}");
            println!(
                "           Upgrade Grok Build for history integrity, session load, \
                 and review features Light expects."
            );
        }
        CliQualification::Unavailable { reason } => {
            println!("grok cli   unavailable: {reason}");
            println!(
                "           Grok Desktop Portable drives the CLI you install and authenticate yourself."
            );
        }
    }

    match control::call(&directory, &ControlRequest::Status).await {
        Ok(_) => println!("host       running"),
        Err(_) => println!("host       not running"),
    }
    Ok(())
}

async fn run_stop() -> Result<(), String> {
    let directory = state_directory()?;
    if control::call(&directory, &ControlRequest::Stop)
        .await
        .is_ok()
    {
        println!("stop requested");
    } else {
        println!("no running host");
    }
    Ok(())
}

/// Enrolment from the terminal.
///
/// This is the setup fallback of ADR light 0006. The browser never reaches
/// here: it can only ask the host to open its own picker, and afterwards
/// refers to the result by an opaque id.
fn run_workspace(args: &[String]) -> Result<(), String> {
    let directory = state_directory()?;
    ensure_private_directory(&directory).map_err(|error| error.to_string())?;
    let mut index = workspace::load(&directory).map_err(|error| error.to_string())?;

    let action = args.first().map_or("list", String::as_str);
    match action {
        "add" => {
            let raw = args
                .get(1)
                .ok_or_else(|| "usage: grok-bridge workspace add <path>".to_owned())?;
            let entry = index
                .enrol(std::path::Path::new(raw), now_ms())
                .map_err(|error| error.to_string())?;
            workspace::persist(&directory, &index).map_err(|error| error.to_string())?;
            println!("{}  {}", entry.id, entry.canonical_path.display());
            println!(
                "\nThe agent will run here with your own authority. Grok Desktop Portable is a \
                 control surface, not a sandbox."
            );
            Ok(())
        }
        "remove" => {
            let id = args
                .get(1)
                .ok_or_else(|| "usage: grok-bridge workspace remove <id>".to_owned())?;
            index.remove(id).map_err(|error| error.to_string())?;
            workspace::persist(&directory, &index).map_err(|error| error.to_string())?;
            println!("removed {id}");
            Ok(())
        }
        "list" => {
            if index.is_empty() {
                println!("no workspaces enrolled — try `grok-bridge workspace add <path>`");
                return Ok(());
            }
            for entry in index.entries() {
                // Report whether the directory is still the one enrolled, so a
                // swap is visible before a session tries to use it.
                let status = match index.resolve(&entry.id) {
                    Ok(_) => "ok",
                    Err(workspace::WorkspaceError::IdentityChanged) => "changed",
                    Err(_) => "missing",
                };
                println!(
                    "{:<8} {:<8} {}",
                    entry.id,
                    status,
                    entry.canonical_path.display()
                );
            }
            Ok(())
        }
        other => Err(format!(
            "unknown workspace action `{other}`. Try add, list, or remove."
        )),
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

async fn run_repair() -> Result<(), String> {
    let directory = state_directory()?;
    if control::call(&directory, &ControlRequest::Status)
        .await
        .is_ok()
    {
        return Err(
            "a host is still running. Stop it first: repair rotates the origin and \
             invalidates every pairing."
                .to_owned(),
        );
    }
    ensure_private_directory(&directory).map_err(|error| error.to_string())?;
    let identity = state::rotate(&directory).map_err(|error| error.to_string())?;
    let origin = identity.origin().map_err(|error| error.to_string())?;
    println!("origin rotated to {origin}");
    println!("every previous pairing and bookmark is now invalid");
    Ok(())
}
