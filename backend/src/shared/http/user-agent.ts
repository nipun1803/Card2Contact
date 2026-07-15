/**
 * Minimal User-Agent parser for Session Conflict screens.
 *
 * Display-only: the result is shown so a user can recognise their other device
 * ("Chrome on macOS"). It is never a security control, so an unrecognised UA
 * degrades to "Unknown" rather than throwing, and we deliberately take no
 * dependency for this — ua-parser-js is ~20KB of browsers we will never see,
 * where a wrong answer costs nothing beyond a vaguer conflict screen.
 */
export interface DeviceInfo {
  /** "macOS", "iPhone", "Windows", "Android", "Unknown device" */
  device: string;
  /** "Chrome", "Safari", "Firefox", "Edge", "Unknown browser" */
  browser: string;
}

/**
 * Order is load-bearing: Edge's UA contains "Chrome", Chrome's contains
 * "Safari", and Opera's contains both — so the most specific pattern must be
 * tested first or every browser reports as Safari.
 */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Edg\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/SamsungBrowser\//, "Samsung Internet"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];

/** iPhone/iPad before "Mac OS X": iOS UAs contain the string "like Mac OS X". */
const DEVICES: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/Windows NT/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux/, "Linux"],
];

function match(
  ua: string,
  table: ReadonlyArray<readonly [RegExp, string]>,
  fallback: string
): string {
  for (const [pattern, label] of table) {
    if (pattern.test(ua)) return label;
  }
  return fallback;
}

export function parseUserAgent(ua: string | undefined): DeviceInfo {
  if (!ua) return { device: "Unknown device", browser: "Unknown browser" };
  // Cap the scanned length: a hostile client can send a multi-KB UA, and no
  // real one needs more than this prefix to classify.
  const head = ua.slice(0, 256);
  return {
    device: match(head, DEVICES, "Unknown device"),
    browser: match(head, BROWSERS, "Unknown browser"),
  };
}
