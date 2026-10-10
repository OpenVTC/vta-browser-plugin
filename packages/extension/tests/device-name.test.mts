// The name this browser registers under as one of the member's devices.

import { test } from "node:test";
import assert from "node:assert/strict";

import { describeThisDevice } from "../src/device-name.ts";

const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

test("Client Hints name the browser and the system", () => {
  assert.deepEqual(
    describeThisDevice({
      userAgent: MAC_CHROME,
      userAgentData: {
        brands: [{ brand: "Chromium" }, { brand: "Google Chrome" }, { brand: "Not=A?Brand" }],
        platform: "macOS",
      },
    }),
    { displayName: "Chrome on macOS", platform: "macOS" },
  );
  assert.equal(
    describeThisDevice({ userAgentData: { brands: [{ brand: "Chromium" }, { brand: "Microsoft Edge" }], platform: "Windows" } })
      .displayName,
    "Edge on Windows",
  );
  assert.equal(
    describeThisDevice({ userAgentData: { brands: [{ brand: "Brave" }, { brand: "Chromium" }], platform: "Linux" } }).displayName,
    "Brave on Linux",
  );
});

test("the user agent string, where there are no Client Hints", () => {
  assert.equal(describeThisDevice({ userAgent: MAC_CHROME }).displayName, "Chrome on macOS");
  assert.equal(
    describeThisDevice({ userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" }).displayName,
    "Firefox on Linux",
  );
  assert.equal(
    describeThisDevice({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    }).displayName,
    "Edge on Windows",
  );
});

test("an unknown browser still gets a name, and no platform is invented", () => {
  assert.deepEqual(describeThisDevice({}), { displayName: "Browser" });
  assert.deepEqual(describeThisDevice({ userAgent: "Something/1.0" }), { displayName: "Browser" });
});
