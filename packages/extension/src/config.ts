// Wallet configuration, persisted in IndexedDB (shared across the service
// worker, offscreen doc, popup, and options page — all the same extension
// origin). IndexedDB rather than chrome.storage because the offscreen document
// — where DIDComm login + onboarding run — does NOT expose chrome.storage,
// while IndexedDB is available in every extension context (and is already the
// holder identity's backing store).
//
// The mediator DID is the wallet's inbox: the relay an RP or executor pushes
// to when it needs to reach this wallet. It is written by onboarding from the
// agent's own advertised DIDComm mediator, and only overridden by hand by an
// operator running more than one relay.
//
// It used to be described here as "baked into the holder's `did:peer:2`
// service endpoint at first mint, so changing it mints a NEW wallet DID".
// That stopped being true at the M2C migration: a v4 holder is a `did:key`
// the VTA mints (`store/holder-identity.ts`), and the mediator is nowhere
// inside it. Changing the inbox now means re-registering the address with
// whoever routes to you — not a new identity.

import { IndexedDBKVStore } from "@openvtc/pnm-core";

/** Who put the inbox mediator there. Absent on records written before this
 *  existed — treated as "nobody is on record", which is the truth. */
export type InboxSource = "agent" | "operator";

export interface WalletSettings {
  /**
   * The wallet's inbox: the mediator an RP or executor pushes to in order to
   * reach this wallet, and the relay the wallet authenticates to for DIDComm
   * login.
   *
   * **Unset until onboarding writes it**, and unset is a real state, not a
   * missing default. It previously fell back to a hardcoded demo mediator on
   * a domain no deployment here runs, so every wallet that never touched the
   * advanced routing field ran its inbox through a third party's host while
   * Setup told the operator it had been "set up automatically from your
   * agent". A default that is wrong everywhere but one workspace is worse
   * than none: absent, the wallet can say the inbox is not configured; wrong,
   * it can only appear to work. (R5 — config absence is the restrictive case.)
   */
  mediatorDid?: string;

  /** Provenance for `mediatorDid`: `agent` when onboarding (or the boot
   *  backfill) adopted the agent's advertised relay, `operator` when a person
   *  typed it into Setup → Message routing. Read by `inboxToAdopt`; see the
   *  note there for why the value alone was not enough to go on. */
  mediatorDidSource?: InboxSource;
  /** Optional default VTA DID prefilled into the step-up flow. */
  defaultStepUpVtaDid?: string;
  /** Optional default VTA mediator DID prefilled into the step-up flow. */
  defaultStepUpVtaMediatorDid?: string;
  /**
   * Additional executor DIDs this wallet is enrolled with, beyond its
   * onboarded VTA(s) — e.g. a did:webvh DID-hosting control plane that signs
   * `task-consent/request`s and step-up `approve-request`s.
   *
   * Every approval request an approver renders must be a Trust-Task document
   * signed by an executor the approver is enrolled with; this list is the
   * operator's way of enrolling executors that are not onboarded VTAs. The
   * onboarded VTA DIDs are always members of the effective set — this only
   * ever widens it.
   */
  enrolledExecutorDids?: string[];
  /**
   * H1 from the May 2026 security review: encrypt the persisted
   * Ed25519 root secret with a key derived from the operator's
   * WebAuthn-PRF authenticator.
   *
   * **Default: `false`.** The wrap relies on
   * `navigator.credentials.create` / `.get`, which require a
   * visible, user-focused context. The current onboarding path
   * runs in the OFFSCREEN document (so it has IndexedDB +
   * DIDComm primitives), which is HIDDEN by design. WebAuthn
   * calls from there either reject with NotAllowedError or hang
   * indefinitely waiting for a user gesture that can never
   * arrive. So flipping the default to `true` (briefly tried in
   * #28) caused onboarding to lock up.
   *
   * The proper fix is a popup-driven enrol: offscreen completes
   * provision-integration → relays the seed to the popup over
   * the bridge → popup (visible) runs the WebAuthn ceremony +
   * encrypts the seed → returns the wrapped record → offscreen
   * stores it. That's queued as a follow-up; until it lands,
   * the operator can still opt in via the Settings page, but
   * the WebAuthn UI may not render correctly. Treat opt-in as
   * EXPERIMENTAL until the popup-driven path ships.
   *
   * **Existing wallets are unaffected** either way — the read
   * path dispatches on the stored record's `algorithm` tag, so
   * a wallet minted under any setting keeps loading via the
   * matching wrap.
   */
  encryptHolderSecret?: boolean;

  /**
   * Push wake-up (binding https://trusttasks.org/binding/push/0.1) — TEST
   * wiring. When both are set, the service worker subscribes to Web Push with
   * the gateway's VAPID public key, registers the subscription with the gateway
   * (`push/register`), and the wallet conveys the resulting handle to the
   * active VTA (`device/set-wake`).
   *
   * Both unset by default — push is opt-in until a gateway is deployed. Drop
   * the gateway's URL + its VAPID *public* key in via the Settings page.
   */
  /** Push gateway base URL (HTTPS transport — `POST {url}/trust-tasks`). */
  pushGatewayUrl?: string;
  /** The gateway's VAPID *public* key (base64url, uncompressed P-256 point) —
   *  the `applicationServerKey` subscribers register. */
  pushGatewayVapidPublicKey?: string;

  /**
   * Prefer TSP as the top-priority transport when a VTA advertises it
   * (`TSPTransport` service). **Default: `true`.**
   *
   * TSP rides the same warm mediator socket as DIDComm (the mediator
   * multiplexes both), so there is no extra socket. The offscreen routes over
   * TSP first, falling back to DIDComm on a *connect* failure (nothing reached
   * the VTA, so the fallback is safe). A TSP *reply* timeout is a hard failure
   * by design — a possibly-applied mutation must not be retried on another
   * transport. Set to `false` to pin a VTA to DIDComm/REST (e.g. if a
   * particular mediator's TSP delivery misbehaves).
   */
  preferTsp?: boolean;
}

/**
 * Which inbox to persist after onboarding at an agent.
 *
 * Returns the mediator to write, or `undefined` to leave the setting alone.
 * The rule, in one place because it is easy to state and easy to get subtly
 * wrong at a call site:
 *
 *  - Nothing advertised → write nothing. An agent that publishes no DIDComm
 *    mediator cannot push to a wallet; an inbox invented here would be a
 *    relay nobody was ever asked about. Unset is the honest state and the
 *    self-test reports it.
 *  - Set, and someone is on record choosing it → leave it here. An operator
 *    pin is final; an `agent`-sourced one is not frozen either, but moving it
 *    is the job of `followAgentInbox` in `background.ts`, which re-resolves
 *    the agent's DID document rather than guessing from a cached connection.
 *    This function only ever fills a blank.
 *  - Otherwise → adopt the agent's. That covers an unset inbox and, once, the
 *    records written before provenance existed.
 *
 * **Why `source` had to exist.** The first cut of this keyed on "is anything
 * set?", which read as sufficient and was not. `setSettings` merged the
 * *defaulted* view of the settings and wrote it back, so under the old
 * hardcoded default any unrelated write — turning on the passkey lock,
 * toggling TSP preference — persisted the demo mediator DID into IndexedDB as
 * though it had been chosen. Wallets therefore carry a stored inbox nobody
 * picked, indistinguishable by value from a deliberate one, and the migration
 * that was supposed to rescue them declined to touch it. (That write-back is
 * fixed in `setSettings` below; this handles the records it already made.)
 *
 * The cost is stated rather than hidden: an operator who hand-set a mediator
 * before provenance existed has it adopted over, once. With nothing deployed
 * and the alternative being wallets stuck on a relay in someone else's
 * deployment, that is the right side to err on — and the person affected is
 * exactly the person who knows how to set it again.
 */
export function inboxToAdopt(
  current: { did?: string | undefined; source?: InboxSource | undefined },
  advertised: string | undefined,
): string | undefined {
  if (!advertised) return undefined;
  // A person chose this relay. Never overridden.
  if (current.source === "operator") return undefined;
  // Already adopted from an agent. Left alone even when the active agent
  // changes: the inbox is an address others route to, and chasing the active
  // VTA would move it out from under them.
  if (current.did && current.source === "agent") return undefined;
  // Either nothing is set, or something is set that no one recorded choosing —
  // which is every record written before provenance existed. Adopt.
  return advertised;
}

const SETTINGS_KEY = "pnm/settings/v1";

/** Read the current settings, falling back to defaults for unset fields. */
/** The record as it is actually stored — no defaults applied.
 *
 *  Separate from `getSettings` because the two have genuinely different jobs,
 *  and conflating them is what produced the inbox defect: `setSettings` merged
 *  the *defaulted* view and wrote it back, so every read-modify-write turned
 *  derived defaults into persisted values that later code could no longer tell
 *  apart from choices. A write must merge onto what is on disk. */
async function storedSettings(): Promise<Partial<WalletSettings>> {
  return (await new IndexedDBKVStore().get<Partial<WalletSettings>>(SETTINGS_KEY)) ?? {};
}

export async function getSettings(): Promise<WalletSettings> {
  const s = await storedSettings();
  // `encryptHolderSecret` defaults to FALSE until the popup-driven
  // WebAuthn-enrol path lands — see the field's docblock for the
  // architectural constraint (offscreen + WebAuthn don't mix).
  // Explicit `true` / `false` round-trip as-is so an operator who
  // opted in (or out) via the Settings page keeps their choice.
  const encryptHolderSecret =
    typeof s?.encryptHolderSecret === "boolean" ? s.encryptHolderSecret : false;
  return {
    ...(s?.mediatorDid ? { mediatorDid: s.mediatorDid } : {}),
    ...(s?.mediatorDidSource === "agent" || s?.mediatorDidSource === "operator"
      ? { mediatorDidSource: s.mediatorDidSource }
      : {}),
    ...(s?.defaultStepUpVtaDid ? { defaultStepUpVtaDid: s.defaultStepUpVtaDid } : {}),
    ...(s?.defaultStepUpVtaMediatorDid
      ? { defaultStepUpVtaMediatorDid: s.defaultStepUpVtaMediatorDid }
      : {}),
    ...(Array.isArray(s?.enrolledExecutorDids)
      ? {
          enrolledExecutorDids: s.enrolledExecutorDids.filter(
            (d): d is string => typeof d === "string" && d.length > 0,
          ),
        }
      : {}),
    encryptHolderSecret,
    preferTsp: typeof s?.preferTsp === "boolean" ? s.preferTsp : true,
    ...(s?.pushGatewayUrl ? { pushGatewayUrl: s.pushGatewayUrl } : {}),
    ...(s?.pushGatewayVapidPublicKey
      ? { pushGatewayVapidPublicKey: s.pushGatewayVapidPublicKey }
      : {}),
  };
}

/** Merge a partial update into the stored settings. */
export async function setSettings(patch: Partial<WalletSettings>): Promise<void> {
  // Merged onto the STORED record, not the defaulted one. See `storedSettings`.
  const stored = await storedSettings();
  await new IndexedDBKVStore().put(SETTINGS_KEY, { ...stored, ...patch });
}
