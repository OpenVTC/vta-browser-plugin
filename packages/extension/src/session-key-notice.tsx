// The consent prompt's notice that a sign-in binds a session key.
//
// A login that carries `sessionKey` (`auth/authenticate/0.2`) gives the site
// more than a session. The page holds a key the relying party will then accept
// as the user, for this session only, with no further prompt from the wallet.
// That is the point of the feature, and it is also exactly what the user is
// agreeing to, so the prompt says it in plain words. It also says what the key
// cannot do: approving a step-up still needs this wallet.
//
// Its own module, so it can be render-tested apart from `confirm.tsx`, which
// reads the window's query string at import time.

export interface SessionKeyNoticeProps {
  /** The `did:key` the site asked to bind, already validated by the background. */
  sessionKey: string;
}

export function SessionKeyNotice({ sessionKey }: SessionKeyNoticeProps) {
  return (
    <div
      role="note"
      data-testid="session-key-notice"
      style={{
        border: "1px solid var(--w-warn)",
        background: "var(--w-warn-soft)",
        borderRadius: 10,
        padding: 12,
        marginBottom: 12,
        fontSize: 12,
      }}
    >
      <strong style={{ display: "block", marginBottom: 4, color: "var(--w-text)" }}>
        This site will get a session key
      </strong>
      <p style={{ margin: "0 0 6px", color: "var(--w-text)" }}>
        For this sign-in only, the site can sign requests as you without asking the wallet
        again. The key stops working when you sign out or the session ends. It cannot approve
        a step-up. That still needs this wallet.
      </p>
      <div style={{ color: "var(--w-faint)", fontSize: 11, marginBottom: 2 }}>Session key:</div>
      <div
        style={{
          wordBreak: "break-all",
          fontSize: 11,
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        }}
      >
        {sessionKey}
      </div>
    </div>
  );
}
