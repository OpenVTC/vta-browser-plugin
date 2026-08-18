// Credential issuance and presentation.
//
// Reachable by a wallet as well as a console — unlike `admin/`, this is
// holder-side surface: the deferred presentations a verifier asked for while
// nobody was there to answer, and the decision on them.
//
// The threaded steps of an exchange (`offer → request → issue`,
// `query → present`) are **not** here. They define no response document, and
// this library's only transport primitive awaits one; see the note at the top
// of `exchange.ts` for what supporting them would take.

export * from "./exchange.js";
