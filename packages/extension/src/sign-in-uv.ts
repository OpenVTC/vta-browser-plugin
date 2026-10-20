// How this browser approves wallet sign-ins at one agent, when it is not the
// PRF passkey: a PIN the agent checks (`vtaPin`) or the person's phone
// (`remoteApprover`). Runs in the offscreen document, which holds the agent
// sessions; the sign-in flow (`sign-in-flows.ts`) and the options page's
// "Sign-in approval" section both come through here.
//
// What is kept, per agent:
//   - `pnm/uv-key/enrolled/<vtaDid>`: which kind the agent holds for which
//     holder (and, for the phone, which phone). Written only after the agent
//     took the enrolment.
//   - `pnm/uv-pin/v1/<vtaDid>`: the PIN's salt and iterations.
// Never the PIN, and never K (the key derived from it): K is derived for one
// enrolment or proof and its bytes wiped once it is used.
//
// Both records are recoverable: every heartbeat response carries the device's
// UV key summary (`kind`, `salt`, `iterations`, `approver`, never the
// verifier), so a browser whose storage was cleared asks the agent and writes
// them back (`recoverEnrolment`).

import {
  buildUvConsentDecision,
  bytesToBase64url,
  base64urlToBytes,
  clearUvPinParams,
  derivePinKey,
  enrolUvKey,
  listUvApprovers,
  newPinSalt,
  pinChangeProof,
  pinProof,
  readUvKeySummary,
  readUvPinParams,
  remoteApproverUvKeyEnrolment,
  vtaPinUvKeyEnrolment,
  writeUvPinParams,
  UV_PIN_ITERATIONS,
  UV_PIN_MIN_LENGTH,
  type KVStore,
  type SigningIdentity,
  type TrustTaskEnvelope,
  type TrustTaskSender,
  type UvApprover,
  type UvConsent,
  type UvKeyEnrolment,
  type UvKeyKind,
} from "@openvtc/pnm-core";

const KINDS: ReadonlySet<string> = new Set<UvKeyKind>(["prfSealedKey", "vtaPin", "remoteApprover"]);

const UV_ENROLLED_PREFIX = "pnm/uv-key/enrolled/";

/** `pnm/uv-key/enrolled/<vtaDid>`: what that agent holds for this holder. */
export interface UvEnrolledRecord {
  /** The holder (this device's transport DID) it was enrolled for. */
  holderDid: string;
  /** Epoch ms. */
  at: number;
  kind: UvKeyKind;
  /** `prfSealedKey`: the UV key's DID. */
  uvDid?: string;
  /** `remoteApprover`: the phone's DID. */
  approver?: string;
}

export function uvEnrolledKey(vtaDid: string): string {
  return UV_ENROLLED_PREFIX + vtaDid;
}

/** What this module needs of the offscreen document. Injected for tests. */
export interface SignInUvDeps {
  store: KVStore;
  /** This device at `vtaDid`: its transport DID and signing key. */
  holder(vtaDid: string): Promise<{ did: string; signing: SigningIdentity }>;
  /** The device's own session with the agent. */
  session(
    vtaDid: string,
    restBaseUrl?: string,
  ): Promise<{ sender: TrustTaskSender; holder: { did: string }; service: { did: string } }>;
  /** This browser's name, for a registration the enrolment falls back to. */
  displayName(): string;
  /** Called once the agent holds an enrolment: the device is registered. */
  enrolled?(vtaDid: string, holderDid: string, at: number): Promise<void>;
  now?(): number;
}

/** A PIN the wallet will not set: too short. Said in the window's words. */
export class PinPolicyError extends Error {
  readonly code = "sign-in/pin-too-short";
  constructor() {
    super(`Use ${UV_PIN_MIN_LENGTH} or more characters.`);
    this.name = "PinPolicyError";
  }
}

/** The PIN's salt is neither on this browser nor at the agent. */
export class PinParamsMissingError extends Error {
  readonly code = "sign-in/pin-unknown";
  constructor() {
    super("Your agent holds no PIN for this browser. Set one up again.");
    this.name = "PinParamsMissingError";
  }
}

/** The record, if it is for the holder this device is now. */
export async function uvEnrolment(deps: SignInUvDeps, vtaDid: string): Promise<UvEnrolledRecord | undefined> {
  const rec = await deps.store.get<UvEnrolledRecord>(uvEnrolledKey(vtaDid));
  if (!rec || typeof rec.kind !== "string") return undefined;
  const { did } = await deps.holder(vtaDid);
  return rec.holderDid === did ? rec : undefined;
}

async function record(deps: SignInUvDeps, vtaDid: string, rec: Omit<UvEnrolledRecord, "at">): Promise<UvEnrolledRecord> {
  const at = (deps.now ?? Date.now)();
  const full: UvEnrolledRecord = { ...rec, at };
  await deps.store.put(uvEnrolledKey(vtaDid), full);
  await deps.enrolled?.(vtaDid, rec.holderDid, at);
  return full;
}

/** Record that `vtaDid` holds the PRF-sealed UV key `uvDid` for `holderDid`. */
export function recordPrfEnrolment(deps: SignInUvDeps, vtaDid: string, holderDid: string, uvDid: string) {
  return record(deps, vtaDid, { holderDid, kind: "prfSealedKey", uvDid });
}

/**
 * What the agent holds for this device, written back here: the record, and a
 * PIN's salt and iterations. For a browser whose storage was cleared.
 * `undefined`: the agent holds no UV key this wallet uses.
 */
export async function recoverEnrolment(
  deps: SignInUvDeps,
  vtaDid: string,
  restBaseUrl?: string,
): Promise<UvEnrolledRecord | undefined> {
  const { sender, holder, service } = await deps.session(vtaDid, restBaseUrl);
  const summary = await readUvKeySummary(sender, { holder, service });
  if (!summary || !KINDS.has(summary.kind)) return undefined;
  const kind = summary.kind as UvKeyKind;
  if (kind === "vtaPin") {
    if (!summary.salt || summary.iterations === undefined) return undefined;
    await writeUvPinParams(deps.store, vtaDid, { salt: summary.salt, iterations: summary.iterations });
  }
  return record(deps, vtaDid, {
    holderDid: holder.did,
    kind,
    ...(kind === "remoteApprover" && summary.approver ? { approver: summary.approver } : {}),
    ...(kind === "prfSealedKey" && summary.did ? { uvDid: summary.did } : {}),
  });
}

/** This agent's record, asking the agent when this browser has none. */
export async function uvEnrolmentOrRecovered(
  deps: SignInUvDeps,
  vtaDid: string,
  restBaseUrl?: string,
): Promise<UvEnrolledRecord | undefined> {
  return (await uvEnrolment(deps, vtaDid)) ?? recoverEnrolment(deps, vtaDid, restBaseUrl);
}

/** K from `pin` and this agent's salt (recovered from the agent when this
 *  browser lost it), for `use`; wiped after. */
async function withStoredPinKey<T>(
  deps: SignInUvDeps,
  vtaDid: string,
  restBaseUrl: string | undefined,
  pin: string,
  use: (k: Uint8Array) => Promise<T>,
): Promise<T> {
  let params = await readUvPinParams(deps.store, vtaDid);
  if (!params) {
    await recoverEnrolment(deps, vtaDid, restBaseUrl);
    params = await readUvPinParams(deps.store, vtaDid);
  }
  if (!params) throw new PinParamsMissingError();
  const k = await derivePinKey(pin, base64urlToBytes(params.salt), params.iterations);
  try {
    return await use(k);
  } finally {
    k.fill(0);
  }
}

/**
 * Send `enrolment` to the agent. Replacing a `vtaPin` key needs the current
 * PIN's proof over the new enrolment; anything else needs nothing extra.
 */
async function enrol(
  deps: SignInUvDeps,
  vtaDid: string,
  restBaseUrl: string | undefined,
  enrolment: UvKeyEnrolment,
  currentPin: string | undefined,
): Promise<string> {
  const current = await uvEnrolment(deps, vtaDid);
  const changeProof =
    current?.kind === "vtaPin"
      ? await withStoredPinKey(deps, vtaDid, restBaseUrl, currentPin ?? "", (k) => pinChangeProof(k, enrolment))
      : undefined;
  const { sender, holder, service } = await deps.session(vtaDid, restBaseUrl);
  await enrolUvKey(sender, {
    holder,
    service,
    enrolment,
    displayName: deps.displayName(),
    ...(changeProof ? { changeProof } : {}),
  });
  return holder.did;
}

/**
 * Make `newPin` how this browser approves at `vtaDid`. `currentPin` is needed
 * when the agent holds a PIN already (changing it).
 *
 * Returns K too, so a sign-in that sets its PIN makes its first proof without
 * deriving it twice. The caller owns those bytes and wipes them (`fill(0)`)
 * once that proof is made; they are wiped here if the enrolment fails.
 */
export async function enrolPin(
  deps: SignInUvDeps,
  vtaDid: string,
  restBaseUrl: string | undefined,
  newPin: string,
  currentPin?: string,
): Promise<{ record: UvEnrolledRecord; key: Uint8Array }> {
  if (newPin.normalize("NFC").length < UV_PIN_MIN_LENGTH) throw new PinPolicyError();
  const salt = newPinSalt();
  const iterations = UV_PIN_ITERATIONS;
  const key = await derivePinKey(newPin, salt, iterations);
  try {
    const holderDid = await enrol(
      deps,
      vtaDid,
      restBaseUrl,
      vtaPinUvKeyEnrolment({ salt, iterations, verifier: key }),
      currentPin,
    );
    // Only once the agent took it: a refused change keeps the old PIN working.
    await writeUvPinParams(deps.store, vtaDid, { salt: bytesToBase64url(salt), iterations });
    return { record: await record(deps, vtaDid, { holderDid, kind: "vtaPin" }), key };
  } catch (err) {
    key.fill(0);
    throw err;
  }
}

/** Make the phone `approver` how this browser approves at `vtaDid`. */
export async function enrolPhone(
  deps: SignInUvDeps,
  vtaDid: string,
  restBaseUrl: string | undefined,
  approver: string,
  currentPin?: string,
): Promise<UvEnrolledRecord> {
  const holderDid = await enrol(deps, vtaDid, restBaseUrl, remoteApproverUvKeyEnrolment(approver), currentPin);
  await clearUvPinParams(deps.store, vtaDid);
  return record(deps, vtaDid, { holderDid, kind: "remoteApprover", approver });
}

/**
 * `ext["org.openvtc.uv-consent"]` for a PIN approval of grant digest `D`: a
 * decision signed by this device's transport key, and the PIN's proof. `key`:
 * K already in hand (the PIN was just set); it is the caller's to wipe.
 */
export async function pinConsent(
  deps: SignInUvDeps,
  vtaDid: string,
  restBaseUrl: string | undefined,
  serviceDid: string,
  pin: string,
  payloadDigest: string,
  key?: Uint8Array,
): Promise<UvConsent> {
  const proof = key
    ? await pinProof(key, payloadDigest)
    : await withStoredPinKey(deps, vtaDid, restBaseUrl, pin, (k) => pinProof(k, payloadDigest));
  const { signing } = await deps.holder(vtaDid);
  const decision: TrustTaskEnvelope = await buildUvConsentDecision({
    uvKey: signing,
    vtaDid: serviceDid,
    payloadDigest,
  });
  return { decision, pinProof: proof };
}

/** The phones this browser may name as its approver at `vtaDid`. */
export async function approvers(
  deps: SignInUvDeps,
  vtaDid: string,
  restBaseUrl?: string,
): Promise<UvApprover[]> {
  const { sender, holder, service } = await deps.session(vtaDid, restBaseUrl);
  return listUvApprovers(sender, { holder, service });
}
