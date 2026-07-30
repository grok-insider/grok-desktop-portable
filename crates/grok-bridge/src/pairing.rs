//! Browser pairing: single-use nonce, session tokens, and CSRF.
//!
//! Implements ADR light 0006. The nonce is minted only for a caller that
//! reached the host over the owner-only control socket, which is what stops
//! another local user from pairing. The host stores only a hash of the browser
//! token, and supports individual and total revocation.
//!
//! Time is supplied by the caller as a millisecond timestamp so that policy is
//! deterministic and testable.

use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::bounds::MAX_OPAQUE_ID_BYTES;

/// Number of random bytes in a pairing nonce and in a session token.
pub const SECRET_BYTES: usize = 32;

/// Default lifetime of a pairing nonce, in milliseconds.
pub const NONCE_TTL_MS: u64 = 90_000;

/// Default lifetime of a browser session, in milliseconds.
pub const SESSION_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1000;

/// Errors produced by the pairing broker.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PairingError {
    /// The presented nonce is unknown, already used, or expired.
    #[error("pairing nonce is not redeemable")]
    NonceNotRedeemable,
    /// The presented session token does not match any live session.
    #[error("browser session is not valid")]
    SessionInvalid,
    /// The presented CSRF token does not match the session.
    #[error("csrf token mismatch")]
    CsrfMismatch,
    /// The platform entropy source failed.
    #[error("secure random generation failed")]
    Entropy,
    /// A supplied opaque value was malformed or oversized.
    #[error("malformed pairing input")]
    Malformed,
}

/// A freshly minted secret, returned to the caller exactly once.
///
/// The value is zeroized on drop. Only its hash is retained by the host.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    /// Borrow the secret value.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl Drop for Secret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(redacted)")
    }
}

/// Result of a successful pairing exchange.
#[derive(Debug)]
pub struct PairedBrowser {
    /// Opaque identifier of the new session, safe to log.
    pub session_id: String,
    /// The session token, delivered once as a cookie value.
    pub session_token: Secret,
    /// The CSRF token, delivered once and held in page memory.
    pub csrf_token: Secret,
}

#[derive(Debug)]
struct Nonce {
    hash: [u8; 32],
    expires_at_ms: u64,
}

#[derive(Debug)]
struct Session {
    id: String,
    token_hash: [u8; 32],
    csrf_hash: [u8; 32],
    expires_at_ms: u64,
}

/// Mints pairing nonces and tracks live browser sessions.
#[derive(Debug, Default)]
pub struct PairingBroker {
    nonce: Option<Nonce>,
    sessions: Vec<Session>,
    next_session: u64,
}

impl PairingBroker {
    /// Create an empty broker with no live sessions.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Mint a single-use pairing nonce, replacing any outstanding one.
    ///
    /// Only one nonce is outstanding at a time: minting a second invalidates
    /// the first, so an abandoned launch cannot be redeemed later.
    ///
    /// # Errors
    ///
    /// Returns [`PairingError::Entropy`] when the platform CSPRNG fails.
    pub fn mint_nonce(&mut self, now_ms: u64) -> Result<Secret, PairingError> {
        let secret = random_hex()?;
        self.nonce = Some(Nonce {
            hash: hash_secret(secret.expose()),
            expires_at_ms: now_ms.saturating_add(NONCE_TTL_MS),
        });
        Ok(secret)
    }

    /// Whether a redeemable nonce is currently outstanding.
    #[must_use]
    pub fn has_pending_nonce(&self, now_ms: u64) -> bool {
        self.nonce
            .as_ref()
            .is_some_and(|nonce| now_ms < nonce.expires_at_ms)
    }

    /// Redeem a nonce for a new browser session.
    ///
    /// The nonce is consumed whether or not it matched, so a wrong guess
    /// cannot be retried against the same value.
    ///
    /// # Errors
    ///
    /// Returns [`PairingError::NonceNotRedeemable`] when no live nonce exists,
    /// the value does not match, or the nonce expired.
    pub fn redeem_nonce(
        &mut self,
        presented: &str,
        now_ms: u64,
    ) -> Result<PairedBrowser, PairingError> {
        if presented.len() > MAX_OPAQUE_ID_BYTES {
            return Err(PairingError::Malformed);
        }
        let nonce = self.nonce.take().ok_or(PairingError::NonceNotRedeemable)?;
        if now_ms >= nonce.expires_at_ms {
            return Err(PairingError::NonceNotRedeemable);
        }
        if !constant_time_eq(&hash_secret(presented), &nonce.hash) {
            return Err(PairingError::NonceNotRedeemable);
        }

        let session_token = random_hex()?;
        let csrf_token = random_hex()?;
        self.next_session = self.next_session.saturating_add(1);
        let session_id = format!("bs-{}", self.next_session);
        self.sessions.push(Session {
            id: session_id.clone(),
            token_hash: hash_secret(session_token.expose()),
            csrf_hash: hash_secret(csrf_token.expose()),
            expires_at_ms: now_ms.saturating_add(SESSION_TTL_MS),
        });
        Ok(PairedBrowser {
            session_id,
            session_token,
            csrf_token,
        })
    }

    /// Verify a session token and return the matching session identifier.
    ///
    /// # Errors
    ///
    /// Returns [`PairingError::SessionInvalid`] when no live session matches.
    pub fn verify_session(&self, token: &str, now_ms: u64) -> Result<String, PairingError> {
        if token.len() > MAX_OPAQUE_ID_BYTES {
            return Err(PairingError::Malformed);
        }
        let presented = hash_secret(token);
        self.sessions
            .iter()
            .find(|session| {
                now_ms < session.expires_at_ms && constant_time_eq(&presented, &session.token_hash)
            })
            .map(|session| session.id.clone())
            .ok_or(PairingError::SessionInvalid)
    }

    /// Verify a session token together with its CSRF token.
    ///
    /// Mutating operations require both. See ADR light 0006.
    ///
    /// # Errors
    ///
    /// Returns [`PairingError::SessionInvalid`] when the session is unknown,
    /// and [`PairingError::CsrfMismatch`] when the CSRF token differs.
    pub fn verify_mutation(
        &self,
        token: &str,
        csrf: &str,
        now_ms: u64,
    ) -> Result<String, PairingError> {
        let session_id = self.verify_session(token, now_ms)?;
        if csrf.len() > MAX_OPAQUE_ID_BYTES {
            return Err(PairingError::Malformed);
        }
        let presented = hash_secret(csrf);
        let matches = self.sessions.iter().any(|session| {
            session.id == session_id && constant_time_eq(&presented, &session.csrf_hash)
        });
        if matches {
            Ok(session_id)
        } else {
            Err(PairingError::CsrfMismatch)
        }
    }

    /// Issue a fresh CSRF token for an existing session.
    ///
    /// The CSRF token lives in page memory only, so a reload must be able to
    /// obtain a new one without repeating the pairing ceremony. Reissuing
    /// invalidates the previous token, so a stale tab cannot keep mutating
    /// after a newer one has resumed.
    ///
    /// # Errors
    ///
    /// Returns [`PairingError::SessionInvalid`] when the session is unknown
    /// and [`PairingError::Entropy`] when the platform CSPRNG fails.
    pub fn reissue_csrf(&mut self, session_id: &str) -> Result<Secret, PairingError> {
        let csrf = random_hex()?;
        let hash = hash_secret(csrf.expose());
        let session = self
            .sessions
            .iter_mut()
            .find(|session| session.id == session_id)
            .ok_or(PairingError::SessionInvalid)?;
        session.csrf_hash = hash;
        Ok(csrf)
    }

    /// Revoke one browser session by identifier.
    ///
    /// Returns whether a session was removed.
    pub fn revoke(&mut self, session_id: &str) -> bool {
        let before = self.sessions.len();
        self.sessions.retain(|session| session.id != session_id);
        self.sessions.len() != before
    }

    /// Revoke every browser session and any outstanding nonce.
    pub fn revoke_all(&mut self) {
        self.sessions.clear();
        self.nonce = None;
    }

    /// Number of live sessions at `now_ms`.
    #[must_use]
    pub fn live_session_count(&self, now_ms: u64) -> usize {
        self.sessions
            .iter()
            .filter(|session| now_ms < session.expires_at_ms)
            .count()
    }
}

fn random_hex() -> Result<Secret, PairingError> {
    let mut raw = [0u8; SECRET_BYTES];
    getrandom::fill(&mut raw).map_err(|_| PairingError::Entropy)?;
    let mut out = String::with_capacity(SECRET_BYTES * 2);
    for byte in raw {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    raw.zeroize();
    Ok(Secret(out))
}

fn hash_secret(value: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"grok-light.pairing.v1\0");
    hasher.update(value.as_bytes());
    hasher.finalize().into()
}

/// Compare two fixed-size digests without an early exit.
fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    let mut diff = 0u8;
    for index in 0..32 {
        diff |= a[index] ^ b[index];
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::{NONCE_TTL_MS, PairingBroker, PairingError};

    const T0: u64 = 1_000_000;

    #[test]
    fn nonce_round_trip_creates_a_session() {
        let mut broker = PairingBroker::new();
        let nonce = broker.mint_nonce(T0).expect("mint");
        assert!(broker.has_pending_nonce(T0));
        let paired = broker
            .redeem_nonce(nonce.expose(), T0 + 10)
            .expect("redeem");
        assert_eq!(broker.live_session_count(T0 + 10), 1);
        assert!(
            broker
                .verify_session(paired.session_token.expose(), T0 + 10)
                .is_ok()
        );
    }

    #[test]
    fn nonce_is_single_use() {
        let mut broker = PairingBroker::new();
        let nonce = broker.mint_nonce(T0).expect("mint");
        let value = nonce.expose().to_owned();
        broker.redeem_nonce(&value, T0 + 1).expect("first redeem");
        assert_eq!(
            broker.redeem_nonce(&value, T0 + 2).unwrap_err(),
            PairingError::NonceNotRedeemable
        );
    }

    #[test]
    fn wrong_nonce_consumes_the_outstanding_one() {
        let mut broker = PairingBroker::new();
        let nonce = broker.mint_nonce(T0).expect("mint");
        let value = nonce.expose().to_owned();
        assert_eq!(
            broker.redeem_nonce(&"0".repeat(64), T0 + 1).unwrap_err(),
            PairingError::NonceNotRedeemable
        );
        // The real value is no longer redeemable either: one guess burns it.
        assert_eq!(
            broker.redeem_nonce(&value, T0 + 2).unwrap_err(),
            PairingError::NonceNotRedeemable
        );
    }

    #[test]
    fn expired_nonce_is_rejected() {
        let mut broker = PairingBroker::new();
        let nonce = broker.mint_nonce(T0).expect("mint");
        assert!(!broker.has_pending_nonce(T0 + NONCE_TTL_MS));
        assert_eq!(
            broker
                .redeem_nonce(nonce.expose(), T0 + NONCE_TTL_MS)
                .unwrap_err(),
            PairingError::NonceNotRedeemable
        );
    }

    #[test]
    fn minting_again_invalidates_the_previous_nonce() {
        let mut broker = PairingBroker::new();
        let first = broker.mint_nonce(T0).expect("mint");
        let first_value = first.expose().to_owned();
        let _second = broker.mint_nonce(T0 + 1).expect("mint again");
        assert_eq!(
            broker.redeem_nonce(&first_value, T0 + 2).unwrap_err(),
            PairingError::NonceNotRedeemable
        );
    }

    #[test]
    fn unknown_session_token_is_rejected() {
        let broker = PairingBroker::new();
        assert_eq!(
            broker.verify_session(&"a".repeat(64), T0),
            Err(PairingError::SessionInvalid)
        );
    }

    #[test]
    fn mutation_requires_matching_csrf() {
        let mut broker = PairingBroker::new();
        let nonce = broker.mint_nonce(T0).expect("mint");
        let paired = broker.redeem_nonce(nonce.expose(), T0 + 1).expect("redeem");
        assert!(
            broker
                .verify_mutation(
                    paired.session_token.expose(),
                    paired.csrf_token.expose(),
                    T0 + 2
                )
                .is_ok()
        );
        assert_eq!(
            broker.verify_mutation(paired.session_token.expose(), &"b".repeat(64), T0 + 2),
            Err(PairingError::CsrfMismatch)
        );
    }

    #[test]
    fn csrf_of_another_session_is_rejected() {
        let mut broker = PairingBroker::new();
        let first_nonce = broker.mint_nonce(T0).expect("mint");
        let first = broker
            .redeem_nonce(first_nonce.expose(), T0 + 1)
            .expect("redeem");
        let second_nonce = broker.mint_nonce(T0 + 2).expect("mint");
        let second = broker
            .redeem_nonce(second_nonce.expose(), T0 + 3)
            .expect("redeem");

        assert_eq!(
            broker.verify_mutation(
                first.session_token.expose(),
                second.csrf_token.expose(),
                T0 + 4
            ),
            Err(PairingError::CsrfMismatch)
        );
    }

    #[test]
    fn sessions_expire() {
        let mut broker = PairingBroker::new();
        let nonce = broker.mint_nonce(T0).expect("mint");
        let paired = broker.redeem_nonce(nonce.expose(), T0 + 1).expect("redeem");
        let far_future = T0 + super::SESSION_TTL_MS + 10;
        assert_eq!(broker.live_session_count(far_future), 0);
        assert_eq!(
            broker.verify_session(paired.session_token.expose(), far_future),
            Err(PairingError::SessionInvalid)
        );
    }

    #[test]
    fn individual_and_total_revocation_work() {
        let mut broker = PairingBroker::new();
        let first_nonce = broker.mint_nonce(T0).expect("mint");
        let first = broker
            .redeem_nonce(first_nonce.expose(), T0 + 1)
            .expect("redeem");
        let second_nonce = broker.mint_nonce(T0 + 2).expect("mint");
        let second = broker
            .redeem_nonce(second_nonce.expose(), T0 + 3)
            .expect("redeem");
        assert_eq!(broker.live_session_count(T0 + 4), 2);

        assert!(broker.revoke(&first.session_id));
        assert!(!broker.revoke(&first.session_id));
        assert_eq!(
            broker.verify_session(first.session_token.expose(), T0 + 5),
            Err(PairingError::SessionInvalid)
        );
        assert!(
            broker
                .verify_session(second.session_token.expose(), T0 + 5)
                .is_ok()
        );

        broker.revoke_all();
        assert_eq!(broker.live_session_count(T0 + 6), 0);
    }

    #[test]
    fn reissuing_csrf_lets_a_reload_resume_without_re_pairing() {
        let mut broker = PairingBroker::new();
        let nonce = broker.mint_nonce(T0).expect("mint");
        let paired = broker.redeem_nonce(nonce.expose(), T0 + 1).expect("redeem");

        let reissued = broker.reissue_csrf(&paired.session_id).expect("reissue");
        assert!(
            broker
                .verify_mutation(paired.session_token.expose(), reissued.expose(), T0 + 2)
                .is_ok()
        );
    }

    #[test]
    fn reissuing_csrf_invalidates_the_previous_token() {
        // A stale tab must not keep mutating after a newer one resumed.
        let mut broker = PairingBroker::new();
        let nonce = broker.mint_nonce(T0).expect("mint");
        let paired = broker.redeem_nonce(nonce.expose(), T0 + 1).expect("redeem");
        let old = paired.csrf_token.expose().to_owned();

        broker.reissue_csrf(&paired.session_id).expect("reissue");
        assert_eq!(
            broker.verify_mutation(paired.session_token.expose(), &old, T0 + 2),
            Err(PairingError::CsrfMismatch)
        );
    }

    #[test]
    fn reissuing_csrf_for_an_unknown_session_is_refused() {
        let mut broker = PairingBroker::new();
        assert_eq!(
            broker.reissue_csrf("bs-404").unwrap_err(),
            PairingError::SessionInvalid
        );
    }

    #[test]
    fn oversized_inputs_are_rejected_without_lookup() {
        let mut broker = PairingBroker::new();
        let huge = "a".repeat(4096);
        assert_eq!(
            broker.redeem_nonce(&huge, T0).unwrap_err(),
            PairingError::Malformed
        );
        assert_eq!(
            broker.verify_session(&huge, T0),
            Err(PairingError::Malformed)
        );
    }

    #[test]
    fn secrets_are_not_printed_in_debug() {
        let mut broker = PairingBroker::new();
        let nonce = broker.mint_nonce(T0).expect("mint");
        let rendered = format!("{nonce:?}");
        assert_eq!(rendered, "Secret(redacted)");
        assert!(!rendered.contains(nonce.expose()));
    }

    #[test]
    fn generated_secrets_are_distinct_and_hex() {
        let mut broker = PairingBroker::new();
        let a = broker.mint_nonce(T0).expect("mint");
        let b = broker.mint_nonce(T0).expect("mint");
        assert_ne!(a.expose(), b.expose());
        assert_eq!(a.expose().len(), super::SECRET_BYTES * 2);
        assert!(a.expose().bytes().all(|c| c.is_ascii_hexdigit()));
    }
}
