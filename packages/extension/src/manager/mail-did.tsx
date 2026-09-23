// A DID in the console, as a link to its mail.
//
// Clicking a DID anywhere an operator is reading about one — an ACL subject, an
// audit actor, a credential's holder, a transport's relay — opens the Mediator
// Lens on that DID: which mediator its mail goes to and, where this wallet has
// standing there, what is waiting for it and who has not collected what it
// sent. A separate component rather than a default on `Did`, because the
// wallet's own surfaces have no lens to point at.

import { Did } from "../ui.js";
import { lensHref } from "./mediator-lens-model.js";

export function MailDid({ value, size }: { value: string; size?: string }) {
  return (
    <Did
      value={value}
      {...(size ? { size } : {})}
      href={lensHref({ did: value })}
      title="Show this DID's mail"
    />
  );
}
