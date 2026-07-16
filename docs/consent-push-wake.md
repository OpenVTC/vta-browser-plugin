# Enabling push wake for the approver ceremony

When a Trust Task needs human consent, the VTA sends a signed
`task-consent/request` to the approver's mediator and then **rings the
approver's doorbell** so the approving device wakes, drains the mediator, and
opens the approval popup (`confirm.html?…&kind=task`). Without the doorbell the
request just sits in the mediator until the extension's worker next happens to
run — which is why an approver can see "nothing happened" after a requester
submitted a task.

The doorbell is a **contentless Web Push**. The whole path is already
implemented across three components; turning it on is **deployment and
configuration, not code**.

## The three moving parts

| Component | Role | Where |
| --- | --- | --- |
| **Extension** | Subscribes to Web Push, registers the subscription with the gateway, relays the opaque `WakeHandle` to the VTA, and drains the mediator on wake. | this repo — `push.ts`, `background.ts` (`ensurePushWake`, the `push` listener), `@openvtc/pnm-core` `device/register-gateway` + `set-wake` |
| **`vti-push-gateway`** | Holds the VAPID keypair + `handle → push-token` map, enforces the VTA-provisioned allowlist, and sends the real RFC-8291 Web Push (also APNs / FCM). | separate repo `vti-push-gateway` (feature-complete) |
| **VTA** | On the `task-consent/request` path, calls `trigger_gateway_wake` (a `push/wake` to the gateway over DIDComm), and provisions the gateway allowlist after `device/set-wake`. | `verifiable-trust-infrastructure` — `trust_tasks/step_up.rs`, `consent_request.rs`, `device.rs` |

The extension side is complete and needs no code changes. The work is standing
up the gateway and pointing everyone at it.

## The one load-bearing gotcha

The VTA only fires the wake to a gateway that advertises a **DID address**:
`trigger_gateway_wake` early-returns unless `wake.gateway` starts with `did:`
(the URL-gateway path is an explicit TODO). The gateway advertises a DID
**only when it is run with a provisioned `did:webvh` identity**
(`GATEWAY_IDENTITY_FILE`); a URL-only gateway silently no-ops the VTA trigger and
you fall back to voluntary mediator pickup.

**So: deploy the gateway with a DIDComm identity, or the doorbell never rings.**

## Steps

### 1. Deploy `vti-push-gateway` with a DID identity

- Generate a VAPID keypair (the gateway can do this — no OpenSSL needed) and set
  `GATEWAY_VAPID_KEY_FILE` (+ `GATEWAY_VAPID_SUBJECT`).
- Provision a `did:webvh` identity for the gateway and set
  `GATEWAY_IDENTITY_FILE` (e.g. `pnm bootstrap provision-integration --template
  push-gateway`). This is what lets the VTA reach it over DIDComm.
- Optionally set `GATEWAY_STORE_FILE` for a durable handle→token map and
  `GATEWAY_ADDR` for the HTTPS listener the extension registers against.
- Note the gateway's **HTTPS base URL** and its **VAPID public key** (base64url,
  uncompressed P-256 point) for the next step.

### 2. Configure the extension (Settings → push gateway)

Both are required, and push is **off by default** until they are set
(`ensurePushWake` returns early when `pushGatewayUrl` is unset):

- **Push gateway URL** — the gateway's HTTPS base (used for the unauthenticated
  `push/register`).
- **Push gateway VAPID public key** — the gateway's key. Without it,
  `subscribeToPush` falls back to a useless probe key and no real wake can be
  delivered.

After saving, the extension subscribes, registers the subscription with the
gateway (getting an opaque `WakeHandle`), and relays that handle to the VTA via
`device/set-wake`.

### 3. Verify the VTA can reach the mediator and the gateway

- The `didcomm` feature must be built in, and `vta_did` +
  `messaging.mediator_did` configured, so the approver's mediator resolves and
  `trigger_gateway_wake` / `provision_gateway` actually run.
- On `device/set-wake`, the VTA sends `push/provision` to the gateway to add the
  handle to its allowlist — confirm the gateway logs the provision.

## Verifying end to end

1. As a **distinct approver identity** (see the two-identity model — the approver
   can't be the requester), connect the extension to the VTA and confirm push is
   registered (gateway logs a `push/register`, VTA a `device/set-wake` +
   `push/provision`).
2. Have a requester submit a consent-gated task.
3. Expect: VTA `task-consent/request` → `push/wake` to the gateway → gateway
   sends the Web Push → the extension's `push` listener fires, drains the
   mediator, and opens the **APPROVER**-mode popup with the change diff.

If the popup doesn't open but the request is in the mediator, the doorbell isn't
ringing — recheck that the gateway is DID-addressed (the gotcha above) and that
the VTA's `didcomm` path is live.

## Known follow-ups (not blockers)

- **URL-addressed gateway wake** — `trigger_gateway_wake` / `provision_gateway`
  have a TODO for the HTTPS-gateway variant; today the gateway must be
  DID-addressed.
- **Targeted wake-draining** — the extension's `handlePushWake` currently
  reconnects and drains *all* onboarded VTAs rather than routing on the specific
  wake. Functionally correct (the pending consent surfaces), but a reconnect
  storm; worth narrowing later.
