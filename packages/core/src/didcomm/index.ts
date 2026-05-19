import {
  buildPlaintextMessage as wasmBuildPlaintextMessage,
  didcommCrateVersion as wasmDidcommCrateVersion,
} from "@pnm/didcomm-wasm";

export interface PlaintextMessageInput {
  id?: string;
  type: string;
  from?: string;
  to?: string[];
  body: unknown;
}

/**
 * Build a DIDComm v2 plaintext message via the WASM bindings over
 * `affinidi-messaging-didcomm`. Returns the serialized JSON form.
 *
 * Smoke-test surface only. Authcrypt / anoncrypt / forward land in
 * the next iteration once the WASM bundle is exercised end-to-end.
 */
export function buildPlaintextMessage(input: PlaintextMessageInput): string {
  return wasmBuildPlaintextMessage(input);
}

export function didcommCrateVersion(): string {
  return wasmDidcommCrateVersion();
}
