// The communities whose portal may show and change the member's own marks —
// stars, petnames, lists — beside its directory (`directory-page.ts`). Asked
// for once per community; this is where the member withdraws it. Withdrawing
// changes no mark: the portal simply asks again before it sees any.

import { useCallback, useEffect, useState } from "react";

import { MARKS_GRANT_PREFIX, type MarksGrant } from "../../directory-page.js";
import { Button, Panel } from "../../ui.js";

async function readGrants(): Promise<MarksGrant[]> {
  const all = (await chrome.storage.local.get(null)) as Record<string, unknown>;
  return Object.entries(all)
    .filter(([k]) => k.startsWith(MARKS_GRANT_PREFIX))
    .map(([, v]) => v as MarksGrant)
    .sort((a, b) => a.communityName.localeCompare(b.communityName));
}

export function MarksGrantsPanel() {
  const [grants, setGrants] = useState<MarksGrant[] | null>(null);
  const reload = useCallback(() => void readGrants().then(setGrants), []);
  useEffect(reload, [reload]);
  if (!grants || grants.length === 0) return null;
  return (
    <Panel
      title="Portals that show your marks"
      description="These communities' portals may show and change your stars, the names you give people and your lists, beside their directory. Your wallet keeps them; withdrawing changes none of them."
    >
      <div style={{ display: "grid", gap: 8 }}>
        {grants.map((g) => (
          <div key={g.hostDid} style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
            <strong style={{ fontSize: "var(--w-t-sm)" }}>{g.communityName}</strong>
            <span style={{ fontSize: "var(--w-t-xs)", color: "var(--w-faint)" }}>
              {g.portalOrigin} · since {new Date(g.grantedAt).toLocaleDateString()}
            </span>
            <Button
              kind="quiet"
              onClick={() => void chrome.storage.local.remove(`${MARKS_GRANT_PREFIX}${g.hostDid}`).then(reload)}
            >
              Withdraw
            </Button>
          </div>
        ))}
      </div>
    </Panel>
  );
}
