import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  enrollPasskey,
  base64urlToBytes,
  enrollmentSubmitFromResult,
  VtaClient,
  VtaClientError,
  type PasskeyVerificationMethod,
} from "@pnm/core";
import { useConnectionStore } from "../store.js";

function useVtaClient() {
  const connection = useConnectionStore((s) => s.connection);
  if (!connection) throw new Error("no connection");
  return {
    client: new VtaClient({
      baseUrl: connection.vtaUrl,
      accessToken: connection.accessToken,
    }),
    did: connection.did,
  };
}

export function Passkeys() {
  const { client, did } = useVtaClient();
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [lastError, setLastError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["passkeys", did],
    queryFn: () => client.listPasskeys(did),
  });

  const enroll = useMutation({
    mutationFn: async (passkeyLabel: string) => {
      const challenge = await client.requestEnrollmentChallenge(did);
      const result = await enrollPasskey({
        challenge: base64urlToBytes(challenge.challenge),
        rp: { id: challenge.rpId, name: challenge.rpName },
        user: {
          id: base64urlToBytes(challenge.userHandle),
          name: challenge.userName,
          displayName: challenge.userDisplayName,
        },
        ...(challenge.timeoutMs !== undefined ? { timeout: challenge.timeoutMs } : {}),
      });
      return client.submitPasskeyEnrollment(
        enrollmentSubmitFromResult(did, result, passkeyLabel || undefined),
      );
    },
    onSuccess: () => {
      setLabel("");
      setLastError(null);
      qc.invalidateQueries({ queryKey: ["passkeys", did] });
    },
    onError: (err) => {
      const e = err as VtaClientError | Error;
      setLastError(e instanceof VtaClientError ? `${e.code}: ${e.message}` : e.message);
    },
  });

  const remove = useMutation({
    mutationFn: (vm: PasskeyVerificationMethod) => {
      const frag = vm.id.split("#")[1] ?? "";
      return client.removePasskey(did, frag);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["passkeys", did] }),
  });

  return (
    <section className="card">
      <h2>Passkeys for this DID</h2>
      <p className="muted">
        Each passkey enrolled below is added as a <code>verificationMethod</code> on
        your DID document with <code>authentication</code> purpose. Any verifier that
        resolves your DID can authenticate a WebAuthn assertion locally — no
        round-trip to your VTA.
      </p>

      <div className="enroll-row">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional, e.g. MacBook Touch ID)"
        />
        <button
          className="primary"
          disabled={enroll.isPending}
          onClick={() => enroll.mutate(label)}
        >
          {enroll.isPending ? "Enrolling…" : "Enroll passkey"}
        </button>
      </div>
      {lastError && <div className="error">{lastError}</div>}

      <h3>Enrolled</h3>
      {list.isLoading && <div>Loading…</div>}
      {list.isError && (
        <div className="error">Failed to list: {(list.error as Error).message}</div>
      )}
      {list.data && list.data.verificationMethods.length === 0 && (
        <div className="muted">No passkeys yet.</div>
      )}
      {list.data && (
        <ul className="vm-list">
          {list.data.verificationMethods.map((vm) => (
            <li key={vm.id} className="vm-item">
              <div className="vm-main">
                <div className="vm-label">{vm.label ?? vm.id.split("#")[1]}</div>
                <div className="vm-id muted">{vm.id}</div>
                <div className="vm-key muted">{vm.publicKeyMultibase}</div>
              </div>
              <button
                className="danger"
                onClick={() => remove.mutate(vm)}
                disabled={remove.isPending}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
