// A DID as a QR code, for a phone to scan off the screen.
//
// The code carries the **bare DID** and nothing else: the string the Copy
// button beside it copies. A DID is already a URI (scheme `did`), so a phone's
// camera can hand it to any wallet registered for that scheme; a `did://` or
// app-specific wrapper would be one more format every scanner has to unwrap.
// It matches what the VTC landing page (`/v1/community/did-qr.svg`) and
// `pnm vta qr` draw, so one scanner reads all three.
//
// Error correction M, as the Keyring enrolment offer uses: a `did:webvh` fits a
// version-5 code (37 modules), easy to scan off a laptop screen.
//
// No DOM here, so the geometry is testable without rendering; `did-qr-view.tsx`
// draws it.

import qrcode from "qrcode-generator";

/** Modules of light margin on every side. Scanners need a quiet zone; four
 *  is what the QR specification requires. */
export const QUIET_ZONE = 4;

/** The code's modules, `true` for dark, row by row, without the quiet zone. */
export function qrModules(text: string): boolean[][] {
  const code = qrcode(0, "M");
  // Byte mode on UTF-8, so the code holds exactly the DID's bytes. The
  // library's default string-to-bytes keeps only the low byte of each UTF-16
  // unit, which is right for an ASCII DID and wrong for anything else.
  code.addData(String.fromCharCode(...new TextEncoder().encode(text)), "Byte");
  code.make();
  const n = code.getModuleCount();
  return Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, col) => code.isDark(row, col)),
  );
}

/**
 * SVG path data drawing every dark module as a unit square, offset by the
 * quiet zone, for a `viewBox` of `0 0 side side` where `side` is the returned
 * value. One path, run-length encoded along each row, so a code is a few
 * hundred commands rather than a thousand elements.
 */
export function qrPath(modules: boolean[][]): { d: string; side: number } {
  const n = modules.length;
  let d = "";
  for (let y = 0; y < n; y++) {
    const row = modules[y]!;
    let x = 0;
    while (x < n) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < n && row[x]) x++;
      d += `M${start + QUIET_ZONE} ${y + QUIET_ZONE}h${x - start}v1h-${x - start}z`;
    }
  }
  return { d, side: n + 2 * QUIET_ZONE };
}
