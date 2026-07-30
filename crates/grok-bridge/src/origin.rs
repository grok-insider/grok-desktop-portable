//! Canonical local origin, port allocation, and exact `Host`/`Origin` checks.
//!
//! Implements ADR light 0006. The origin is
//! `http://<install-id>.grok-light.localhost:<port>`. The random hostname is
//! the only cookie isolation boundary available over plain loopback HTTP,
//! because cookies are not scoped by port.

use std::fmt;

use crate::bounds::MAX_OPAQUE_ID_BYTES;

/// Fixed hostname suffix under which every installation gets a random label.
pub const ORIGIN_SUFFIX: &str = ".grok-light.localhost";

/// Number of bytes of randomness in an install identifier.
pub const INSTALL_ID_BYTES: usize = 16;

/// Lowest port considered for allocation.
///
/// Chosen below the Linux default ephemeral range start (32768) so a routine
/// outbound socket cannot take the canonical port. See ADR light 0006.
pub const PORT_RANGE_START: u16 = 20_000;

/// Highest port considered for allocation, exclusive of the ephemeral range.
pub const PORT_RANGE_END: u16 = 32_767;

/// Errors produced while constructing or validating a local origin.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum OriginError {
    /// The install identifier was empty, oversized, or not lowercase hex.
    #[error("invalid install identifier")]
    InvalidInstallId,
    /// The port fell inside the ephemeral range or was otherwise unusable.
    #[error("port {0} is not allocatable for a stable local origin")]
    UnallocatablePort(u16),
    /// A request carried a `Host` or `Origin` that is not the canonical value.
    #[error("request origin did not match the canonical origin")]
    OriginMismatch,
}

/// The canonical loopback origin for one installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalOrigin {
    install_id: String,
    port: u16,
}

impl LocalOrigin {
    /// Build an origin from an existing install identifier and port.
    ///
    /// # Errors
    ///
    /// Returns [`OriginError::InvalidInstallId`] when the identifier is not
    /// lowercase hex of a sane length, and [`OriginError::UnallocatablePort`]
    /// when the port is outside the stable allocation range.
    pub fn new(install_id: impl Into<String>, port: u16) -> Result<Self, OriginError> {
        let install_id = install_id.into();
        if !is_valid_install_id(&install_id) {
            return Err(OriginError::InvalidInstallId);
        }
        if !is_allocatable_port(port) {
            return Err(OriginError::UnallocatablePort(port));
        }
        Ok(Self { install_id, port })
    }

    /// The random per-installation label.
    #[must_use]
    pub fn install_id(&self) -> &str {
        &self.install_id
    }

    /// The stable canonical port.
    #[must_use]
    pub const fn port(&self) -> u16 {
        self.port
    }

    /// The canonical hostname, without scheme or port.
    #[must_use]
    pub fn host_name(&self) -> String {
        format!("{}{ORIGIN_SUFFIX}", self.install_id)
    }

    /// The canonical `Host` header value, including the port.
    #[must_use]
    pub fn host_header(&self) -> String {
        format!("{}:{}", self.host_name(), self.port)
    }

    /// The canonical `Origin` header value.
    #[must_use]
    pub fn origin_header(&self) -> String {
        format!("http://{}", self.host_header())
    }

    /// Validate a request's `Host` and `Origin` headers against this origin.
    ///
    /// `Host` is always required and must match exactly.
    ///
    /// `Origin` handling depends on the request kind, because browsers do not
    /// send `Origin` on same-origin safe requests. This was verified against
    /// Chrome 150: a document navigation and a same-origin `GET` carry no
    /// `Origin` at all, while `POST` and `DELETE` carry it exactly. Requiring
    /// it unconditionally would reject the application's own document load.
    ///
    /// - [`RequestKind::Safe`]: `Origin` may be absent; when present it must
    ///   match exactly, so a cross-origin `GET` is still refused.
    /// - [`RequestKind::Mutation`] and [`RequestKind::WebSocket`]: `Origin` is
    ///   required and must match exactly.
    ///
    /// The literal `null`, an alias, a different scheme, and a different port
    /// are always rejected. See ADR light 0006.
    ///
    /// # Errors
    ///
    /// Returns [`OriginError::OriginMismatch`] when a header is missing where
    /// required, or differs from the canonical value.
    pub fn verify_request(
        &self,
        kind: RequestKind,
        host: Option<&str>,
        origin: Option<&str>,
    ) -> Result<(), OriginError> {
        let host = host.ok_or(OriginError::OriginMismatch)?;
        if host != self.host_header() {
            return Err(OriginError::OriginMismatch);
        }
        match (kind, origin) {
            (RequestKind::Safe, None) => Ok(()),
            (_, Some(value)) if value == self.origin_header() => Ok(()),
            _ => Err(OriginError::OriginMismatch),
        }
    }
}

/// How strictly the `Origin` header is required for a request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestKind {
    /// A safe method that browsers may send without an `Origin` header.
    Safe,
    /// A state-changing method. Browsers always attach `Origin`.
    Mutation,
    /// A WebSocket upgrade. Browsers always attach `Origin`.
    WebSocket,
}

/// Whether a `Sec-Fetch-Site` value is consistent with a same-origin request.
///
/// Used as a secondary signal only. Absence is not a failure, because the
/// header is not universally present, and presence is never the sole control.
#[must_use]
pub fn sec_fetch_site_is_same_origin(value: Option<&str>) -> bool {
    matches!(value, None | Some("same-origin" | "none"))
}

impl fmt::Display for LocalOrigin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.origin_header())
    }
}

/// Whether `port` may be used as a stable canonical port.
///
/// Ports inside the platform ephemeral range are rejected so that a routine
/// outbound connection cannot occupy the origin between restarts.
#[must_use]
pub const fn is_allocatable_port(port: u16) -> bool {
    port >= PORT_RANGE_START && port <= PORT_RANGE_END
}

/// Whether `value` is a well-formed install identifier.
#[must_use]
pub fn is_valid_install_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_OPAQUE_ID_BYTES
        && value.len() == INSTALL_ID_BYTES * 2
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() && b.is_ascii_hexdigit() || b.is_ascii_digit())
}

/// Generate a fresh random install identifier from the operating system CSPRNG.
///
/// # Errors
///
/// Returns an error when the platform entropy source is unavailable.
pub fn generate_install_id() -> Result<String, getrandom::Error> {
    let mut raw = [0u8; INSTALL_ID_BYTES];
    getrandom::fill(&mut raw)?;
    let mut out = String::with_capacity(INSTALL_ID_BYTES * 2);
    for byte in raw {
        use fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    Ok(out)
}

/// Derive a deterministic candidate port inside the stable allocation range.
///
/// Installation picks a candidate from the install identifier so a reinstall
/// with the same identifier prefers the same port, then probes upward for a
/// free one. The caller performs the actual bind.
#[must_use]
pub fn candidate_port(install_id: &str, attempt: u16) -> u16 {
    let span = PORT_RANGE_END - PORT_RANGE_START + 1;
    let seed = install_id.bytes().fold(0u32, |acc, b| {
        acc.wrapping_mul(31).wrapping_add(u32::from(b))
    });
    let base = u16::try_from(seed % u32::from(span)).unwrap_or(0);
    PORT_RANGE_START + (base.wrapping_add(attempt) % span)
}

#[cfg(test)]
mod tests {
    use super::{
        LocalOrigin, OriginError, PORT_RANGE_END, PORT_RANGE_START, RequestKind, candidate_port,
        generate_install_id, is_allocatable_port, is_valid_install_id,
        sec_fetch_site_is_same_origin,
    };

    fn origin() -> LocalOrigin {
        LocalOrigin::new("0123456789abcdef0123456789abcdef", 20_001).expect("valid origin")
    }

    #[test]
    fn canonical_strings_are_stable() {
        let origin = origin();
        assert_eq!(
            origin.host_name(),
            "0123456789abcdef0123456789abcdef.grok-light.localhost"
        );
        assert_eq!(
            origin.host_header(),
            "0123456789abcdef0123456789abcdef.grok-light.localhost:20001"
        );
        assert_eq!(
            origin.origin_header(),
            "http://0123456789abcdef0123456789abcdef.grok-light.localhost:20001"
        );
    }

    #[test]
    fn exact_host_and_origin_are_accepted_for_every_kind() {
        let origin = origin();
        for kind in [
            RequestKind::Safe,
            RequestKind::Mutation,
            RequestKind::WebSocket,
        ] {
            assert!(
                origin
                    .verify_request(
                        kind,
                        Some(&origin.host_header()),
                        Some(&origin.origin_header())
                    )
                    .is_ok(),
                "{kind:?} with exact headers must be accepted"
            );
        }
    }

    #[test]
    fn safe_requests_are_accepted_without_an_origin_header() {
        // Verified against Chrome 150: a document navigation and a same-origin
        // GET carry no Origin header at all. Requiring it would reject the
        // application's own document load.
        let origin = origin();
        assert!(
            origin
                .verify_request(RequestKind::Safe, Some(&origin.host_header()), None)
                .is_ok()
        );
    }

    #[test]
    fn mutations_and_upgrades_require_an_origin_header() {
        // Verified against Chrome 150: POST and DELETE always carry Origin.
        let origin = origin();
        for kind in [RequestKind::Mutation, RequestKind::WebSocket] {
            assert_eq!(
                origin.verify_request(kind, Some(&origin.host_header()), None),
                Err(OriginError::OriginMismatch),
                "{kind:?} must require an Origin header"
            );
        }
    }

    #[test]
    fn a_cross_origin_safe_request_is_still_rejected() {
        // Absence is tolerated; a wrong value never is.
        let origin = origin();
        assert_eq!(
            origin.verify_request(
                RequestKind::Safe,
                Some(&origin.host_header()),
                Some("http://evil.example")
            ),
            Err(OriginError::OriginMismatch)
        );
    }

    #[test]
    fn missing_host_is_always_rejected() {
        let origin = origin();
        for kind in [
            RequestKind::Safe,
            RequestKind::Mutation,
            RequestKind::WebSocket,
        ] {
            assert_eq!(
                origin.verify_request(kind, None, Some(&origin.origin_header())),
                Err(OriginError::OriginMismatch)
            );
        }
    }

    #[test]
    fn null_origin_is_rejected() {
        let origin = origin();
        for kind in [
            RequestKind::Safe,
            RequestKind::Mutation,
            RequestKind::WebSocket,
        ] {
            assert_eq!(
                origin.verify_request(kind, Some(&origin.host_header()), Some("null")),
                Err(OriginError::OriginMismatch)
            );
        }
    }

    #[test]
    fn aliases_and_loopback_literals_are_rejected() {
        let origin = origin();
        for host in [
            "localhost:20001",
            "127.0.0.1:20001",
            "[::1]:20001",
            "grok-light.localhost:20001",
            "0123456789abcdef0123456789abcdef.grok-light.localhost",
            "0123456789abcdef0123456789abcdef.grok-light.localhost:20001.evil.example",
        ] {
            assert_eq!(
                origin.verify_request(
                    RequestKind::Mutation,
                    Some(host),
                    Some(&origin.origin_header())
                ),
                Err(OriginError::OriginMismatch),
                "host {host} must not be accepted"
            );
        }
    }

    #[test]
    fn a_different_port_is_a_different_origin() {
        let origin = origin();
        let other = "http://0123456789abcdef0123456789abcdef.grok-light.localhost:20002";
        assert_eq!(
            origin.verify_request(
                RequestKind::Mutation,
                Some(&origin.host_header()),
                Some(other)
            ),
            Err(OriginError::OriginMismatch)
        );
    }

    #[test]
    fn https_scheme_is_not_the_canonical_origin() {
        let origin = origin();
        let other = "https://0123456789abcdef0123456789abcdef.grok-light.localhost:20001";
        assert_eq!(
            origin.verify_request(
                RequestKind::Mutation,
                Some(&origin.host_header()),
                Some(other)
            ),
            Err(OriginError::OriginMismatch)
        );
    }

    #[test]
    fn a_different_install_id_is_a_different_origin() {
        let origin = origin();
        let other = "http://fedcba9876543210fedcba9876543210.grok-light.localhost:20001";
        assert_eq!(
            origin.verify_request(
                RequestKind::Mutation,
                Some(&origin.host_header()),
                Some(other)
            ),
            Err(OriginError::OriginMismatch)
        );
    }

    #[test]
    fn sec_fetch_site_is_a_secondary_signal_only() {
        // Verified against Chrome 150: navigations report `none` and
        // same-origin fetches report `same-origin`. Absence is tolerated.
        assert!(sec_fetch_site_is_same_origin(None));
        assert!(sec_fetch_site_is_same_origin(Some("same-origin")));
        assert!(sec_fetch_site_is_same_origin(Some("none")));
        assert!(!sec_fetch_site_is_same_origin(Some("cross-site")));
        assert!(!sec_fetch_site_is_same_origin(Some("same-site")));
    }

    #[test]
    fn ephemeral_ports_are_not_allocatable() {
        assert!(!is_allocatable_port(32_768));
        assert!(!is_allocatable_port(60_999));
        assert!(!is_allocatable_port(0));
        assert!(is_allocatable_port(PORT_RANGE_START));
        assert!(is_allocatable_port(PORT_RANGE_END));
    }

    #[test]
    fn origin_rejects_ephemeral_port() {
        let err = LocalOrigin::new("0123456789abcdef0123456789abcdef", 40_000).unwrap_err();
        assert_eq!(err, OriginError::UnallocatablePort(40_000));
    }

    #[test]
    fn install_id_shape_is_enforced() {
        assert!(is_valid_install_id("0123456789abcdef0123456789abcdef"));
        assert!(!is_valid_install_id(""));
        assert!(!is_valid_install_id("short"));
        assert!(!is_valid_install_id("0123456789ABCDEF0123456789ABCDEF"));
        assert!(!is_valid_install_id("0123456789abcdef0123456789abcdeg"));
    }

    #[test]
    fn generated_ids_are_valid_and_distinct() {
        let a = generate_install_id().expect("entropy");
        let b = generate_install_id().expect("entropy");
        assert!(is_valid_install_id(&a));
        assert!(is_valid_install_id(&b));
        assert_ne!(a, b);
    }

    #[test]
    fn candidate_ports_stay_in_range_and_advance() {
        let id = "0123456789abcdef0123456789abcdef";
        let first = candidate_port(id, 0);
        let second = candidate_port(id, 1);
        assert!(is_allocatable_port(first));
        assert!(is_allocatable_port(second));
        assert_ne!(first, second);
        for attempt in 0..500 {
            assert!(is_allocatable_port(candidate_port(id, attempt)));
        }
    }

    #[test]
    fn candidate_port_is_deterministic_per_install() {
        let a = candidate_port("0123456789abcdef0123456789abcdef", 0);
        let b = candidate_port("0123456789abcdef0123456789abcdef", 0);
        let c = candidate_port("fedcba9876543210fedcba9876543210", 0);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }
}
