// DID hosting — the `did-management/*` control plane.
//
// **A different counterparty from everything else in this library.** These
// tasks go to a did:webvh hosting service, which publishes DID documents and
// serves their logs; an agent is a client of one. The recipient of every
// envelope here is that service, with its own ACL.
//
// `dids.ts` manages individual DIDs; `domains.ts` manages the domains they are
// served under and the server instances doing the serving.

export * from "./dids.js";
export * from "./domains.js";
