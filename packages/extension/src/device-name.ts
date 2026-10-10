// What this browser calls itself when it registers as one of the member's
// devices: "Chrome on macOS", "Firefox on Linux".
//
// The name is all an operator has to go on when they look down their list of
// devices and decide which one to disable, so it says what a person would: the
// browser and the operating system. It is not a security input — the VTA never
// decides anything on it (dtgwg `device/register/0.2`) — so a guess that comes
// out as "Browser on Linux" is harmless, just less helpful.

/** The parts of `navigator` read here, so tests can pass their own. */
export interface NavigatorLike {
  userAgent?: string;
  userAgentData?: { brands?: ReadonlyArray<{ brand: string }>; platform?: string };
}

export interface DeviceDescription {
  /** "Chrome on macOS". */
  displayName: string;
  /** "macOS", when the operating system is known. */
  platform?: string;
}

/** Brands as `navigator.userAgentData` spells them, most specific first:
 *  every Chromium browser also lists "Chromium". */
const BRANDS: ReadonlyArray<[string, string]> = [
  ["Microsoft Edge", "Edge"],
  ["Brave", "Brave"],
  ["Opera", "Opera"],
  ["Vivaldi", "Vivaldi"],
  ["Google Chrome", "Chrome"],
  ["Chromium", "Chromium"],
];

/** User-agent tokens, most specific first: Edge and Opera also say "Chrome",
 *  and Chrome also says "Safari". */
const UA_BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/Firefox\//, "Firefox"],
  [/Edg\//, "Edge"],
  [/OPR\//, "Opera"],
  [/Vivaldi\//, "Vivaldi"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const UA_SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/CrOS/, "ChromeOS"],
  [/Android/, "Android"],
  [/iPhone|iPad/, "iOS"],
  [/Macintosh|Mac OS X/, "macOS"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
];

/** `userAgentData.platform` values, mapped to the names used above. */
const PLATFORMS: Readonly<Record<string, string>> = {
  macOS: "macOS",
  Windows: "Windows",
  Linux: "Linux",
  "Chrome OS": "ChromeOS",
  ChromeOS: "ChromeOS",
  Android: "Android",
};

function browserName(nav: NavigatorLike): string | undefined {
  const brands = nav.userAgentData?.brands ?? [];
  for (const [brand, name] of BRANDS) {
    if (brands.some((b) => b.brand === brand)) return name;
  }
  const ua = nav.userAgent ?? "";
  return UA_BROWSERS.find(([re]) => re.test(ua))?.[1];
}

function systemName(nav: NavigatorLike): string | undefined {
  const platform = nav.userAgentData?.platform;
  if (platform && PLATFORMS[platform]) return PLATFORMS[platform];
  const ua = nav.userAgent ?? "";
  return UA_SYSTEMS.find(([re]) => re.test(ua))?.[1];
}

/** This browser, as one of the member's devices. */
export function describeThisDevice(
  nav: NavigatorLike = (globalThis as { navigator?: NavigatorLike }).navigator ?? {},
): DeviceDescription {
  const browser = browserName(nav) ?? "Browser";
  const system = systemName(nav);
  return {
    displayName: system ? `${browser} on ${system}` : browser,
    ...(system ? { platform: system } : {}),
  };
}
