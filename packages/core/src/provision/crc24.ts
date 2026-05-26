// PGP-style CRC24 over raw bytes. Used by the armor parser to detect
// pasted-text corruption before the AEAD layer has a chance to.
//
// Mirrors `crc24` in `vta-sdk/src/sealed_transfer/armor.rs`:
//   init  = 0x00B704CE
//   poly  = 0x01864CFB
//   width = 24 bits, output big-endian, no reflection.
//
// Reference vector at the bottom of this file; the armor parser must
// reject a corrupted body via `Crc24Mismatch` before HPKE sees it.

const INIT = 0x00b704ce;
const POLY = 0x01864cfb;

export function crc24(data: Uint8Array): number {
  let crc = INIT;
  for (let i = 0; i < data.length; i++) {
    crc ^= (data[i] as number) << 16;
    for (let bit = 0; bit < 8; bit++) {
      crc <<= 1;
      if ((crc & 0x01000000) !== 0) crc ^= POLY;
    }
  }
  return crc & 0x00ffffff;
}

/** Encode a 24-bit CRC value as the 3 big-endian bytes the armor body line
 *  base64-encodes after the `=` prefix. */
export function crc24ToBytes(crc: number): Uint8Array {
  return new Uint8Array([(crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff]);
}
