import { useState } from "react";
import {
  didcommCrateVersion,
  smokeAuthcryptRoundtrip,
  smokeBuildDidcommEnrollChallenge,
  smokeDidcommVtaTransportRoundtrip,
  smokeMediatorEnrollment,
  smokeMediatorNotifications,
  smokeWalletBoot,
} from "@openvtc/pnm-core";

interface SmokeResult {
  name: string;
  ok?: boolean;
  payload?: unknown;
  error?: string;
  durationMs?: number;
}

type SmokeFn = () =>
  | { ok: boolean; error?: string }
  | Promise<{ ok: boolean; error?: string }>;

const SMOKES: ReadonlyArray<readonly [string, SmokeFn]> = [
  ["authcrypt round-trip (crypto layer)", smokeAuthcryptRoundtrip],
  ["build DIDComm enroll-challenge (compose only)", smokeBuildDidcommEnrollChallenge],
  ["DIDComm enroll-challenge round-trip (in-memory bridge)", smokeDidcommVtaTransportRoundtrip],
  ["mediator enrollment (coordinate-mediation/2.0)", smokeMediatorEnrollment],
  ["mediator notifications (live-delivery + ack)", smokeMediatorNotifications],
  ["wallet boot (full session bootstrap + resume)", smokeWalletBoot],
];

export function Smokes() {
  const [results, setResults] = useState<SmokeResult[]>([]);
  const [running, setRunning] = useState(false);

  async function runAll() {
    setRunning(true);
    const next: SmokeResult[] = [];
    for (const [name, fn] of SMOKES) {
      const started = performance.now();
      try {
        const r = await fn();
        const durationMs = Math.round(performance.now() - started);
        const entry: SmokeResult = {
          name,
          ok: r.ok,
          payload: r,
          durationMs,
        };
        if (r.error) entry.error = r.error;
        next.push(entry);
      } catch (err) {
        next.push({
          name,
          ok: false,
          error: (err as Error).message,
          durationMs: Math.round(performance.now() - started),
        });
      }
      setResults([...next]);
    }
    setRunning(false);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => r.ok === false).length;

  return (
    <section className="card">
      <h2>Diagnostic smokes</h2>
      <p className="muted">
        End-to-end validators that exercise the WASM + DIDComm layers in
        this browser. Use to confirm the bundle loaded and the crypto
        path is intact (e.g. after a reinstall, or first deploy).
        <br />
        Linked DIDComm crate: <code>{didcommCrateVersion()}</code>.
      </p>
      <div className="enroll-row">
        <button className="primary" onClick={runAll} disabled={running}>
          {running ? "Running…" : "Run all"}
        </button>
        {results.length > 0 && (
          <span className="muted" style={{ alignSelf: "center" }}>
            {passed} passed
            {failed > 0 ? `, ${failed} failed` : ""}
            {" "}({results.length}/{SMOKES.length})
          </span>
        )}
      </div>

      <ul className="vm-list" style={{ marginTop: "1rem" }}>
        {results.map((r) => (
          <li key={r.name} className="vm-item">
            <div className="vm-main">
              <div className="vm-label">
                {r.ok === true ? "✓" : r.ok === false ? "✗" : "…"} {r.name}
              </div>
              <div className="vm-id muted">
                {r.durationMs !== undefined ? `${r.durationMs}ms · ` : ""}
                {r.error ?? JSON.stringify(r.payload)}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
