// Shared helpers for both demo pages. No framework, no build step — a reviewer
// may well read this, and there is nothing here worth hiding behind a bundler.

/** Fetch the site's public config once and fill every `data-config` element. */
export async function loadConfig() {
  const res = await fetch("/api/config", { headers: { accept: "application/json" } });
  const cfg = await res.json();

  for (const el of document.querySelectorAll("[data-config]")) {
    const key = el.dataset.config;
    if (key === "deletesOn-phrase") {
      // A configured date is far more reassuring than "in seven days", which
      // reads as a promise nobody is holding. Fall back only when unset.
      el.textContent = cfg.deletesOn
        ? `on ${cfg.deletesOn}`
        : `${cfg.grantExpires ?? "7 days"} after it is stood up`;
      continue;
    }
    if (cfg[key] !== undefined && cfg[key] !== null && cfg[key] !== "") {
      el.textContent = String(cfg[key]);
    }
  }

  for (const el of document.querySelectorAll("[data-copy-config]")) {
    el.addEventListener("click", async () => {
      const value = String(cfg[el.dataset.copyConfig] ?? "");
      if (!value) return;
      await navigator.clipboard.writeText(value);
      const previous = el.textContent;
      el.textContent = "Copied";
      setTimeout(() => {
        el.textContent = previous;
      }, 1200);
    });
  }

  return cfg;
}

/**
 * The wallet injects `window.vtaWallet` only on origins the user has enabled,
 * and the injection can land after this script runs — so callers check now, and
 * again when the wallet announces itself on `vtawallet:ready`.
 */
export function walletPresent() {
  return typeof window.vtaWallet?.login === "function";
}

/** Keep a "the wallet is not here yet" hint in step with reality. */
export function trackWalletPresence(hintId) {
  const reflect = () => {
    const el = document.getElementById(hintId);
    if (el) el.hidden = walletPresent();
  };
  reflect();
  window.addEventListener("vtawallet:ready", reflect);
  return reflect;
}

/** Show a result in one of the pages' `.msg` slots. */
export function say(id, text, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = `msg ${kind}`;
  el.hidden = false;
}

export function clear(id) {
  const el = document.getElementById(id);
  if (el) el.hidden = true;
}

/** POST JSON to this origin and return the parsed body plus the status. */
export async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let parsed = {};
  try {
    parsed = await res.json();
  } catch {
    // A response with no JSON body is still a result — the status carries it.
  }
  return { status: res.status, ...parsed };
}

/** Run an async handler with the button disabled, so a slow grant cannot be
 *  double-submitted by an impatient click. */
export async function withButton(id, fn) {
  const btn = document.getElementById(id);
  const label = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Working…";
  }
  try {
    await fn();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
  }
}
