# did:webs party documents

Copied from `@openvtc/vti-didcomm-js`
(<https://github.com/OpenVTC/vti-didcomm-js>,
`test/fixtures/did-webs/parties/`, commit `f283fa1`, vti-didcomm-js #39),
Apache-2.0. Only the DID (`did.txt`) and the document the Rust resolver
(`affinidi-did-webs` 0.13.3) derived from the published artifacts
(`resolved.json`) are copied; the generator and the `keri.cesr` / `did.json`
artifacts are in that repository's README beside the originals.

- `vta/` — a VTA with **key roles** (VTI-KEY-173): the `attestation` key
  (`assertionMethod`) and the `operational` key (`authentication`) are
  different Ed25519 keys, and `keyAgreement` lists a P-256 key before an X25519
  key.
  - Ed25519 attestation secret: the 32-byte seed of `0x32`.
  - Ed25519 operational secret: the 32-byte seed of `0x33`.
  - X25519 key agreement secret: 32 bytes of `0x31`; P-256: 32 bytes of `0x34`.
- `mediator/` — one Ed25519 key (under `authentication` and
  `assertionMethod`), one X25519 key agreement key (secret: 32 bytes of
  `0x41`) and a `DIDCommMessaging` service.

These are test keys derived from constant bytes; they must never hold anything.
