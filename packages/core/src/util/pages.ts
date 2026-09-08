// Reading a cursor-paginated listing to the end.
//
// ## Why a helper rather than a loop at each call site
//
// Every `persona/…/list` task in the persona family answers with a page and a
// `nextCursor`, and the specification is explicit about how that must be read:
// "a producer MUST NOT infer exhaustion from a short page — only an absent
// `nextCursor` means the end." The clients here were named `...List`, documented
// as *enumerate the pool* and *every persona bound in this context*, and
// returned the first page while dropping the cursor on the floor.
//
// That failure is invisible in exactly the way that matters. Nothing errors,
// nothing looks partial, and the console's identity map — whose whole premise is
// one picture of everything — draws a face pointing at attributes that are not
// in the list, under counts that agree with each other because they are all
// counting the same truncated array. A picture that reads as complete while
// being partial is the one wrong answer that pane must never give.
//
// ## The bound is not a page limit, it is a loop guard
//
// `maxPages` exists because a cursor comes from the far side: an agent that
// returns the same cursor forever, or one whose pool genuinely exceeds what any
// caller could draw, must not spin this in a service worker. It is set high
// enough that reaching it means something is wrong rather than something is
// large.
//
// **Reaching it throws.** Returning what was collected would reintroduce the
// defect this exists to fix, one layer down and with a longer array — and a
// caller cannot tell a short answer from a complete one, which is the whole
// problem. An error names the situation and the surface can say so.

/** One page, in the shape every `…/list` response shares. */
export interface Page<T> {
  items: T[];
  nextCursor?: string | undefined;
}

/** How many pages `collectPages` will read before deciding the far side is
 *  misbehaving. At the specification's maximum page size of 500 this is 25,000
 *  records — beyond any pool a person curates by hand, which is the point. */
export const MAX_PAGES = 50;

/**
 * Follow `nextCursor` until it is absent, and return everything.
 *
 * `fetchPage` is called with `undefined` first and with each cursor after it.
 * `what` names the listing in the error, because "too many pages" without a
 * subject is a message nobody can act on.
 */
export async function collectPages<T>(
  what: string,
  fetchPage: (cursor?: string | undefined) => Promise<Page<T>>,
  maxPages: number = MAX_PAGES,
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const next: Page<T> = await fetchPage(cursor);
    all.push(...next.items);
    // Absence is the only exhaustion signal — a short page is not one, and an
    // empty page carrying a cursor is a legal answer this must keep following.
    if (next.nextCursor === undefined) return all;
    // A cursor that does not move is the far side looping. Caught here rather
    // than by the page bound alone so the message says which fault it was.
    if (next.nextCursor === cursor) {
      throw new Error(`${what}: your agent returned the same page cursor twice, so the listing cannot be finished`);
    }
    cursor = next.nextCursor;
  }
  throw new Error(
    `${what}: still more after ${maxPages} pages — refusing to keep asking, because a listing this long is ` +
      `an agent misbehaving rather than a pool this size`,
  );
}
