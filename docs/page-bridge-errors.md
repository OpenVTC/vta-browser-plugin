# Page bridge errors: `message` and `code`

Every `window.vtaWallet.*` call rejects with the same kind of error, on every
channel: `elections`, `rooms` (including `rooms.getFile` / `rooms.putFile`),
`directory`, `git`, and the top-level methods.

```ts
interface VtaWalletError extends Error {
  name: "VtaWalletError";
  message: string; // the wallet's words, for the member; reworded freely
  code: string;    // the machine-readable reason; stable
}
```

**Switch on `code`, never on `message`.** The message is prose the wallet
rewords whenever it likes, and is unchanged by this contract. The code is a
single camelCase name (`/^[a-z][A-Za-z0-9]{0,63}$/`) and is always present.

```js
try {
  await window.vtaWallet.elections.show({ hostDid, electionId });
} catch (e) {
  switch (e.code) {
    case "electionUnknown": /* the community shows the member no such election */ break;
    case "indeterminate":   /* the community could not check the credential yet: retry later */ break;
    case "declined":  /* the member's choice in the wallet: not an error to show */ break;
    case "walletLocked":    /* ask them to unlock; listen for `vtawallet:unlocked` */ break;
    default:                /* show e.message */
  }
}
```

`takeTickets` does not reject for one election that failed: that election's
entry is `{ outcome: "failed", error, code }`, with the same `code` a rejection
would carry.

## Where a code comes from

A code is one of three things.

1. **A Trust Task error code**, when the community, the room host or the
   member's agent refused. It is the code's local part: a §8.5 extended code
   `vtc/elections/show:electionUnknown` arrives as `electionUnknown`, a §8.3
   standard code (`permissionDenied`, `indeterminate`, …) as it is. The
   meaning is the one the specification of the task gives it.
2. **A wallet code** (below), for what the wallet itself decided or ran into.
   No wallet code is a §8.3 standard code, and only one shares its name with
   an extended code of a task VTI pins: `declined`, which `auth/oob/redeem`
   and `vetting/request` also define — in both, as a refusal to go on with
   the request, the same reading a page gives the wallet's. Neither task
   answers on a page channel, so a page reads `code` without asking who said
   it.
3. **A rooms work code** (below), for an offer acceptance or a file transfer
   that failed in the wallet's rooms engine.

A failure the wallet has given no code of its own is `unclassified`: show the
message.

The election refusals the wallet rewrites into the member's words keep the
community's code. For example `vtc/elections/show:electionUnknown`,
`indeterminate`, `presentationRequired`, `membershipNotProven`,
`membershipRevoked`, `rollUntrusted`, `notOpen`, `alreadyIssued`,
`notEligible`, `manifestMismatch` and `permissionDenied` all reach the page by
those names, as do the member's agent's `membershipCredentialMismatch`,
`membershipCredentialUnusable`, `membershipCredentialRequired` and
`memberNotHeld`. `vote` on an election the community's list does not show, with
nothing naming the party it is put to, rejects `electionUnknown` too: it is the
community's answer, read off its list.

## Wallet codes

A name here is a contract with every portal: one is added, never renamed or
reused. `WALLET_ERROR_CODES` in `packages/extension/src/page-error.ts` is the
source; a test fails if this table and that list differ.

| Code | Meaning |
| --- | --- |
| `invalidCall` | The call is not one this channel serves: an unknown method or operation, a member it does not take, a value of the wrong shape. Fix the call. |
| `originNotPermitted` | The page's origin may not make this call: the browser attested none, or it is not the portal the community's own DID document names. |
| `notConnected` | The wallet is connected to no agent, or to one it has no way to reach. |
| `walletLocked` | The wallet is locked. Ask the member to unlock it from the wallet's popup; the page hears `vtawallet:unlocked` when they do. |
| `hostPermissionRequired` | The wallet has not been allowed to reach the community's (or the room host's) endpoint. The member allows it from the wallet. |
| `identityUnknown` | The wallet holds no identity the member uses at this community, or not the one the page named as `member`. |
| `identityAmbiguous` | The member uses more than one identity at this community and the page named none: pass `member`. |
| `declined` | The member declined, or closed the wallet's window, without agreeing. Their choice, not a failure to show. |
| `notShared` | A room the page asked about is not shared with it, or its share ran out: ask the member to share it again (`rooms.choose`). |
| `offerNotListed` | Rooms: the community lists no such offer to the member now. |
| `offerInProgress` | Rooms: this offer is being accepted already, from another surface. |
| `membershipNotHeld` | Elections: the member holds no membership credential issued by the party the election is put to, so they are not a member of that party here. |
| `credentialNotHeld` | Directory: the member's wallet holds no credential the fields can be filled from. |
| `disclosureExceeded` | Directory: the credential would disclose more than the member agreed to in the wallet's window; nothing was presented. |
| `rollChanged` | Elections: the roll changed between the member's decision and the claim; nothing was presented. Read the election again. |
| `timedOut` | The agent, the community or the host did not answer in time. |
| `unreachable` | The wallet could not reach the agent, the community or the host. |
| `walletUnavailable` | The wallet itself did not answer: its background or offscreen document was not running, or a transfer's port closed. Retrying may work. |
| `unclassified` | Anything not yet given a code of its own. Show the message. |

`declined` is the code for every "the member said no" — not taking a
ticket, not showing a membership to read an election, not publishing a card,
not presenting a credential, not linking an account, not adding a note or a
file, not accepting a room offer. `vote` never rejects with it: whatever the
member did in the ballot window, the page hears the same `{ ticketTaken: false }`.

## Rooms work codes

`rooms.acceptOffer`, `rooms.getFile` and `rooms.putFile` reject with the codes
the wallet's rooms engine gives (`@openvtc/pnm-core` `RoomOfferErrorCode` and
`RoomFileError`). Some are the Trust Task code the host or the agent refused
with; the rest are the engine's reading of what went wrong. `ROOMS_WORK_CODES`
in `page-error.ts` is the source, checked against the engine at compile time.

| Code | Meaning |
| --- | --- |
| `actUnsupported` | The member's agent does not serve the room key operations an acceptance needs. |
| `noRoomOffers` | The party makes no room offers. |
| `communityRefused` | The community refused to answer the member. |
| `capability` | The member's agent refused this wallet a capability the step needs. |
| `notPersona` | The member's agent holds no key of the member this wallet may act as. |
| `keyPackageNotHeld` | The member's agent no longer holds the KeyPackage's private half. |
| `notAMember` | The host does not count the member as a member of the room. |
| `notFound` | No open or recently accepted offer of the room to the member. |
| `offerExpired` | The offer has expired. |
| `alreadyAccepted` | The offer was accepted already. |
| `admissionPending` | The community could not yet tell whether the member was admitted: retry. |
| `keyHolderRefused` | The community's own agent refused to admit the member. |
| `keyPackageInvalid` | The KeyPackage was refused as invalid. |
| `welcomeMissing` | A sealed room admitted the member and sent no Welcome. |
| `joinFailed` | The member's agent did not join from the Welcome. |
| `noAnswer` | The answer did not arrive: retrying sends the same acceptance. |
| `filesDisabled` | The host does not accept files in this room. |
| `tooLarge` | The file is larger than the room takes. |
| `noFile` | The record carries no file, or it has been retracted. |
| `blobNotNamed` | The host no longer names the file's blob on the record; it may have been released. |
| `hostMisbehaved` | The host answered with something it should not have. |
| `notVerified` | The file did not verify against its author's digest; none of it was given to the page. |
| `versionRace` | The room kept moving while the file was written: put it again. |
| `aborted` | The transfer was stopped. |

## What a code never carries

A code is a fixed name, never data. Before a code leaves the wallet it is
checked against the pattern above, and the page-world script checks it again;
anything else becomes `unclassified`. So no party can put into a code anything
the page would not already read in the message: no credential, no choice, no
persona detail (VTI-NTF-063, VTI-VOT-090). A cast's failure is shown only in
the wallet's own ballot window and never reaches the page, code or message.
