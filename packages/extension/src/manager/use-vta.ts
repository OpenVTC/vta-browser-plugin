/// <reference types="chrome" />

// Which agent this console is administering, and what it may do there.
//
// Two separate questions, deliberately answered by two different places:
//
//  - **Which agent** comes from `chrome.storage.local` (`active-vta.ts`), the
//    same connection record the popup and background read. The console does not
//    get its own notion of "the active VTA"; a second one would drift.
//
//  - **What this caller may do** comes from the agent itself, via `whoAmI`, and
//    is never inferred from anything stored locally. That is the whole point of
//    the task: it re-resolves roles and scopes at call time rather than reading
//    them out of an access token, so a role granted or revoked since the token
//    was minted shows up immediately. A console that cached authority would
//    show an operator buttons they can no longer use, and — worse — hide ones
//    they just gained.

import { useCallback, useEffect, useState } from "react";
import type { TaskParty } from "@openvtc/pnm-core";
import { whoAmI, type Session } from "@openvtc/pnm-core/admin";
import { readActiveHolderDid, readActiveVtaDid } from "../active-vta.js";
import { managerSender } from "./sender.js";

/** The two DIDs an admin envelope names. See `TaskParty` in core for why this
 *  is the whole of what the console needs — composing a document requires no
 *  key material, and the console holds none. */
export interface Parties {
  holder: TaskParty;
  service: TaskParty;
}

export interface Authority {
  session: Session;
  roles: string[];
  scopes: string[];
}

export type VtaState =
  | { status: "loading" }
  /** No agent onboarded, or the connection record is gone. Not an error — a
   *  fresh install looks exactly like this, and the console says so. */
  | { status: "disconnected" }
  | { status: "ready"; parties: Parties; authority: Authority | null; authorityError: string | null };

/**
 * Resolve the active agent and this caller's authority at it.
 *
 * `refreshAuthority` is exported deliberately: **every mutation calls it**. An
 * `acl/change-role` or a `contexts/create` can change what the caller may do
 * next, and the honest moment to find that out is immediately after the change,
 * not on the next full page load.
 */
export function useVta(): VtaState & { refreshAuthority: () => Promise<void> } {
  const [state, setState] = useState<VtaState>({ status: "loading" });

  const loadAuthority = useCallback(async (parties: Parties) => {
    try {
      const authority = await whoAmI(managerSender, parties);
      setState({ status: "ready", parties, authority, authorityError: null });
    } catch (e) {
      // An ACL rejection here is an *answer*, not a glitch: the caller really
      // has no authority at this agent. Keep the console open and say so —
      // blanking the page would leave an operator unable to see even which
      // agent they are failing to reach.
      setState({
        status: "ready",
        parties,
        authority: null,
        authorityError: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const [vtaDid, holderDid] = await Promise.all([readActiveVtaDid(), readActiveHolderDid()]);
      if (!vtaDid || !holderDid) {
        setState({ status: "disconnected" });
        return;
      }
      const parties: Parties = { holder: { did: holderDid }, service: { did: vtaDid } };
      setState({ status: "ready", parties, authority: null, authorityError: null });
      await loadAuthority(parties);
    })();
  }, [loadAuthority]);

  const refreshAuthority = useCallback(async () => {
    if (state.status !== "ready") return;
    await loadAuthority(state.parties);
  }, [state, loadAuthority]);

  return { ...state, refreshAuthority };
}

/**
 * Whether the agent has told us this caller holds `role`.
 *
 * Used to *disable and explain*, never to hide. A hidden control tells an
 * operator their agent has no such feature; a disabled one with a reason tells
 * them who to ask. And it is advisory in both cases — the agent's ACL is the
 * only authority that decides, and it decides again on every task regardless of
 * what this returns.
 */
export function hasRole(authority: Authority | null, ...roles: string[]): boolean {
  if (!authority) return false;
  return roles.some((r) => authority.roles.includes(r));
}
