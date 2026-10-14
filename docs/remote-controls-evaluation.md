# Remote folders, control transfer and browsers

Three independent browser flags select these candidates: `remote-projects`,
`control-transfer` and `device-panel`. Each also requires an affirmative
capability from the authenticated host. Ordinary builds and hosts keep them
disabled. Native switches are `SPANREED_REMOTE_EXPERIMENT_PROJECTS`,
`SPANREED_REMOTE_EXPERIMENT_CONTROL_TRANSFER` and
`SPANREED_REMOTE_EXPERIMENT_DEVICE_PANEL`; accepted values are `1` and `true`.

## Folder selection

The browser lists only roots approved in Spanreed on the computer. It sends
opaque directory handles and pagination cursors, never a typed path
or an instruction to open a host dialog. Browsing is available to observers;
enrollment requires the controlling connection. Breadcrumbs retain only labels
and handles. `parentId` in a page identifies the listed directory, not its
parent. Handles expire after five minutes, so a stale selection returns the
user to Approved roots. A changed filesystem identity requires a fresh explicit
selection; enrollment is never retried automatically.
Repeating a cursor within its validity window returns the same page, so a lost
response does not consume it.

## Connection control

A request belongs to the current connection and expires after thirty seconds.
The host advertises and accepts transfer only in Shared mode.
Two tabs can share a browser grant while remaining different connections. The
UI therefore retains only the request returned to its own connection when
offering cancellation; a request with the same browser ID is not sufficient.
The current controller explicitly selects a pending request to transfer
control. `hostStatus` remains authoritative for the resulting role and epoch;
a successful command alone must not promote the requesting browser locally.

`remoteDevicesChanged` invalidates the browser-list projection. The frontend
does not derive role changes from that notification. It reloads the list for
the same authenticated host and connection generation. A reconnect or account,
host or installation change clears the previous request and projections.
A refreshed list that no longer contains this connection's request also
clears its pending indication. Late responses cannot restore an old request
after role changes, including promotion followed by demotion.

## Browser access

The list reports exact grant IDs, current-browser and controller roles,
connection counts and connected/disconnected state. The host currently reports
no last-activity time and the UI says so. It does not invent device names or
describe disconnected grants as revoked. The current browser can remove its
own grant; removing another requires control. Both use a second explicit local
confirmation naming the selected browser. The confirmation is cancelled on
disconnection, control change or scope change. Managed own-browser removal
uses the same confirmed revoke-and-forget path as the computer header and
returns to the managed computer selection. An unconfirmed revocation keeps
local pairing and reports the failure. Confirmed revocation with failed
storage cleanup reports that distinction.

## Evaluation still required

Component tests verify feature/capability gates, opaque folder actions,
read-only observers, pagination, confirmation, scope reset, connection-bound
request ownership and expiration. Wire parsers reject malformed, unbounded or
contradictory projections. These checks do not qualify native filesystem
confinement, lease transfer or revocation delivery.

The synthetic combined browser fixture passed 25 functional/layout checks in
hidden Sway Chrome 155 on 2026-10-13, with no page errors. It exercised folder
refusal, opaque enrollment, observer restrictions, explicit transfer and both
revocation routes with drafts and share insertion active. The session panel
scrolls within the viewport so expanded tools do not hide the composer or
confirmation. See `apps/web/qa/README.md` for the reproducible checks and exact
evidence. This does not substitute for the native host tests below.

Run the combined browser/host artifact against approved roots, symlink escape,
renamed directories, stale handles and replayed cursors. Exercise at least
fifty transfers between distinct connections, simultaneous requests, reconnect
with an old epoch, expiring requests and two tabs sharing one grant. Verify
that revocation closes the correct channels, leaves other grants intact and
cannot cross host or account scope. Include a clock-skew check: the display
uses host expiry timestamps while the host alone authorizes the transfer.

Finally, on the S24, measure whether browsing approved roots, moving control
and managing browser access improve real tasks enough to meet the registered
utility threshold. Until those receipts are complete the candidates remain
experimental and disabled by default.
