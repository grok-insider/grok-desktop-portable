//! The single controlling tab and its monotonic epoch.
//!
//! Implements ADR light 0006. Exactly one tab may mutate state or decide a
//! permission. A second tab is blocked and may show status only. A short grace
//! covers reload and reconnect of the same tab. There is no forcible takeover
//! of a live controller in v1.

/// Default heartbeat interval before a lease is considered stale, in ms.
pub const LEASE_TIMEOUT_MS: u64 = 15_000;

/// Grace window that lets the same tab reconnect after a reload, in ms.
pub const RECONNECT_GRACE_MS: u64 = 10_000;

/// Errors produced by the control lease.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LeaseError {
    /// Another tab currently holds the lease and is still alive.
    #[error("another tab holds the control lease")]
    Held,
    /// The caller is not the controller.
    #[error("caller does not hold the control lease")]
    NotController,
    /// The caller presented an epoch that is no longer current.
    #[error("stale controller epoch")]
    StaleEpoch,
}

/// State of the control lease at a point in time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseState {
    /// No tab holds the lease.
    Vacant,
    /// A tab holds the lease and is heartbeating.
    Held,
    /// The holder stopped heartbeating but is still inside the grace window.
    Grace,
}

#[derive(Debug, Clone)]
struct Holder {
    session_id: String,
    connection_id: String,
    epoch: u64,
    last_seen_ms: u64,
}

/// Tracks which browser tab may act.
#[derive(Debug, Default)]
pub struct ControlLease {
    holder: Option<Holder>,
    epoch: u64,
}

impl ControlLease {
    /// Create a vacant lease.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Current epoch. Increments on every acquisition.
    #[must_use]
    pub const fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Lease state at `now_ms`.
    #[must_use]
    pub fn state(&self, now_ms: u64) -> LeaseState {
        match &self.holder {
            None => LeaseState::Vacant,
            Some(holder) => {
                let since = now_ms.saturating_sub(holder.last_seen_ms);
                if since < LEASE_TIMEOUT_MS {
                    LeaseState::Held
                } else if since < LEASE_TIMEOUT_MS + RECONNECT_GRACE_MS {
                    LeaseState::Grace
                } else {
                    LeaseState::Vacant
                }
            }
        }
    }

    /// The identifier of the browser session holding the lease, if any.
    #[must_use]
    pub fn holder_session(&self) -> Option<&str> {
        self.holder
            .as_ref()
            .map(|holder| holder.session_id.as_str())
    }

    /// Attempt to acquire the lease for a connection.
    ///
    /// A vacant lease is granted. A lease in grace is granted only to the same
    /// browser session, which is what makes reload work without allowing a
    /// second tab to steal control.
    ///
    /// # Errors
    ///
    /// Returns [`LeaseError::Held`] when a different live tab holds it.
    pub fn acquire(
        &mut self,
        session_id: &str,
        connection_id: &str,
        now_ms: u64,
    ) -> Result<u64, LeaseError> {
        match (self.state(now_ms), self.holder.as_mut()) {
            (LeaseState::Held, Some(holder)) => {
                if holder.session_id == session_id && holder.connection_id == connection_id {
                    holder.last_seen_ms = now_ms;
                    Ok(holder.epoch)
                } else {
                    Err(LeaseError::Held)
                }
            }
            (LeaseState::Grace, Some(holder)) => {
                if holder.session_id == session_id {
                    Ok(self.grant(session_id, connection_id, now_ms))
                } else {
                    Err(LeaseError::Held)
                }
            }
            // A non-vacant state without a holder cannot occur, but it is
            // treated as vacant rather than panicking.
            (LeaseState::Vacant, _) | (_, None) => {
                Ok(self.grant(session_id, connection_id, now_ms))
            }
        }
    }

    fn grant(&mut self, session_id: &str, connection_id: &str, now_ms: u64) -> u64 {
        self.epoch = self.epoch.saturating_add(1);
        self.holder = Some(Holder {
            session_id: session_id.to_owned(),
            connection_id: connection_id.to_owned(),
            epoch: self.epoch,
            last_seen_ms: now_ms,
        });
        self.epoch
    }

    /// Refresh the lease from a heartbeat.
    ///
    /// # Errors
    ///
    /// Returns [`LeaseError::NotController`] when the caller does not hold it.
    pub fn heartbeat(&mut self, connection_id: &str, now_ms: u64) -> Result<(), LeaseError> {
        let holder = self.holder.as_mut().ok_or(LeaseError::NotController)?;
        if holder.connection_id != connection_id {
            return Err(LeaseError::NotController);
        }
        holder.last_seen_ms = now_ms;
        Ok(())
    }

    /// Check that a mutating command carries the current epoch.
    ///
    /// # Errors
    ///
    /// Returns [`LeaseError::NotController`] when the connection does not hold
    /// the lease and [`LeaseError::StaleEpoch`] when the epoch is not current.
    pub fn authorize(
        &self,
        connection_id: &str,
        presented_epoch: u64,
        now_ms: u64,
    ) -> Result<(), LeaseError> {
        if self.state(now_ms) != LeaseState::Held {
            return Err(LeaseError::NotController);
        }
        let holder = self.holder.as_ref().ok_or(LeaseError::NotController)?;
        if holder.connection_id != connection_id {
            return Err(LeaseError::NotController);
        }
        if presented_epoch != holder.epoch {
            return Err(LeaseError::StaleEpoch);
        }
        Ok(())
    }

    /// Release the lease if held by this connection.
    pub fn release(&mut self, connection_id: &str) -> bool {
        let held = self
            .holder
            .as_ref()
            .is_some_and(|holder| holder.connection_id == connection_id);
        if held {
            self.holder = None;
        }
        held
    }

    /// Drop the holder unconditionally, for example on host shutdown.
    pub fn clear(&mut self) {
        self.holder = None;
    }
}

#[cfg(test)]
mod tests {
    use super::{ControlLease, LEASE_TIMEOUT_MS, LeaseError, LeaseState, RECONNECT_GRACE_MS};

    const T0: u64 = 500_000;

    #[test]
    fn first_tab_acquires_and_epoch_advances() {
        let mut lease = ControlLease::new();
        assert_eq!(lease.state(T0), LeaseState::Vacant);
        let epoch = lease.acquire("bs-1", "conn-a", T0).expect("acquire");
        assert_eq!(epoch, 1);
        assert_eq!(lease.state(T0), LeaseState::Held);
        assert_eq!(lease.holder_session(), Some("bs-1"));
    }

    #[test]
    fn second_tab_is_blocked_while_the_first_is_live() {
        let mut lease = ControlLease::new();
        lease.acquire("bs-1", "conn-a", T0).expect("acquire");
        assert_eq!(
            lease.acquire("bs-2", "conn-b", T0 + 100),
            Err(LeaseError::Held)
        );
    }

    #[test]
    fn a_second_connection_of_the_same_session_cannot_steal_a_live_lease() {
        let mut lease = ControlLease::new();
        lease.acquire("bs-1", "conn-a", T0).expect("acquire");
        assert_eq!(
            lease.acquire("bs-1", "conn-b", T0 + 100),
            Err(LeaseError::Held)
        );
    }

    #[test]
    fn reacquire_by_the_same_connection_is_idempotent() {
        let mut lease = ControlLease::new();
        let first = lease.acquire("bs-1", "conn-a", T0).expect("acquire");
        let again = lease.acquire("bs-1", "conn-a", T0 + 10).expect("reacquire");
        assert_eq!(first, again);
        assert_eq!(lease.epoch(), 1);
    }

    #[test]
    fn same_session_reconnects_within_grace_with_a_new_epoch() {
        let mut lease = ControlLease::new();
        lease.acquire("bs-1", "conn-a", T0).expect("acquire");
        let grace_at = T0 + LEASE_TIMEOUT_MS + 1;
        assert_eq!(lease.state(grace_at), LeaseState::Grace);
        let epoch = lease
            .acquire("bs-1", "conn-b", grace_at)
            .expect("reconnect");
        assert_eq!(epoch, 2);
        assert_eq!(lease.state(grace_at), LeaseState::Held);
    }

    #[test]
    fn a_different_session_cannot_take_over_during_grace() {
        let mut lease = ControlLease::new();
        lease.acquire("bs-1", "conn-a", T0).expect("acquire");
        let grace_at = T0 + LEASE_TIMEOUT_MS + 1;
        assert_eq!(
            lease.acquire("bs-2", "conn-b", grace_at),
            Err(LeaseError::Held)
        );
    }

    #[test]
    fn lease_becomes_vacant_after_grace_expires() {
        let mut lease = ControlLease::new();
        lease.acquire("bs-1", "conn-a", T0).expect("acquire");
        let after = T0 + LEASE_TIMEOUT_MS + RECONNECT_GRACE_MS + 1;
        assert_eq!(lease.state(after), LeaseState::Vacant);
        let epoch = lease.acquire("bs-2", "conn-b", after).expect("acquire");
        assert_eq!(epoch, 2);
    }

    #[test]
    fn heartbeat_keeps_the_lease_held() {
        let mut lease = ControlLease::new();
        lease.acquire("bs-1", "conn-a", T0).expect("acquire");
        let later = T0 + LEASE_TIMEOUT_MS - 1;
        lease.heartbeat("conn-a", later).expect("heartbeat");
        assert_eq!(lease.state(later + LEASE_TIMEOUT_MS - 1), LeaseState::Held);
    }

    #[test]
    fn heartbeat_from_a_non_controller_is_rejected() {
        let mut lease = ControlLease::new();
        lease.acquire("bs-1", "conn-a", T0).expect("acquire");
        assert_eq!(
            lease.heartbeat("conn-b", T0 + 1),
            Err(LeaseError::NotController)
        );
    }

    #[test]
    fn authorize_requires_controller_and_current_epoch() {
        let mut lease = ControlLease::new();
        let epoch = lease.acquire("bs-1", "conn-a", T0).expect("acquire");
        assert!(lease.authorize("conn-a", epoch, T0 + 1).is_ok());
        assert_eq!(
            lease.authorize("conn-b", epoch, T0 + 1),
            Err(LeaseError::NotController)
        );
        assert_eq!(
            lease.authorize("conn-a", epoch + 1, T0 + 1),
            Err(LeaseError::StaleEpoch)
        );
    }

    #[test]
    fn epoch_from_before_a_reconnect_is_stale() {
        let mut lease = ControlLease::new();
        let old = lease.acquire("bs-1", "conn-a", T0).expect("acquire");
        let grace_at = T0 + LEASE_TIMEOUT_MS + 1;
        let new = lease
            .acquire("bs-1", "conn-b", grace_at)
            .expect("reconnect");
        assert_ne!(old, new);
        assert_eq!(
            lease.authorize("conn-b", old, grace_at + 1),
            Err(LeaseError::StaleEpoch)
        );
        assert!(lease.authorize("conn-b", new, grace_at + 1).is_ok());
    }

    #[test]
    fn authorize_fails_once_the_lease_is_only_in_grace() {
        let mut lease = ControlLease::new();
        let epoch = lease.acquire("bs-1", "conn-a", T0).expect("acquire");
        let grace_at = T0 + LEASE_TIMEOUT_MS + 1;
        assert_eq!(
            lease.authorize("conn-a", epoch, grace_at),
            Err(LeaseError::NotController)
        );
    }

    #[test]
    fn release_frees_the_lease_for_another_tab() {
        let mut lease = ControlLease::new();
        lease.acquire("bs-1", "conn-a", T0).expect("acquire");
        assert!(lease.release("conn-a"));
        assert!(!lease.release("conn-a"));
        assert_eq!(lease.state(T0 + 1), LeaseState::Vacant);
        assert!(lease.acquire("bs-2", "conn-b", T0 + 1).is_ok());
    }

    #[test]
    fn release_by_a_non_holder_does_nothing() {
        let mut lease = ControlLease::new();
        lease.acquire("bs-1", "conn-a", T0).expect("acquire");
        assert!(!lease.release("conn-b"));
        assert_eq!(lease.state(T0 + 1), LeaseState::Held);
    }
}
