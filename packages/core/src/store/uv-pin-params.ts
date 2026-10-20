// What the wallet keeps of a PIN that approves its sign-ins at one VTA
// (`vtaPin`, see `vault/uv-pin.ts`): the PBKDF2 salt and iterations. Never the
// PIN, never the key derived from it.

import type { KVStore } from "./kv-store.js";

const PIN_PARAMS_PREFIX = "pnm/uv-pin/v1/";

/** `pnm/uv-pin/v1/<vtaDid>`. Never the PIN, never K. */
export interface UvPinParams {
  /** base64url. */
  salt: string;
  iterations: number;
}

export function uvPinParamsKey(vtaDid: string): string {
  return PIN_PARAMS_PREFIX + vtaDid;
}

export async function readUvPinParams(store: KVStore, vtaDid: string): Promise<UvPinParams | undefined> {
  const rec = await store.get<UvPinParams>(uvPinParamsKey(vtaDid));
  return rec && typeof rec.salt === "string" && typeof rec.iterations === "number" ? rec : undefined;
}

export async function writeUvPinParams(store: KVStore, vtaDid: string, params: UvPinParams): Promise<void> {
  await store.put(uvPinParamsKey(vtaDid), { salt: params.salt, iterations: params.iterations } satisfies UvPinParams);
}

export async function clearUvPinParams(store: KVStore, vtaDid: string): Promise<void> {
  await store.delete(uvPinParamsKey(vtaDid));
}
