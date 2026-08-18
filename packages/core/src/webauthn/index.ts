// Re-exported, not owned: base64url is a plain encoding helper that `did/` and
// `vta/` also need, and having them reach into `webauthn/` for it made two
// modules depend on WebAuthn to do arithmetic on bytes. It lives in `util/`;
// this line keeps `@openvtc/pnm-core/webauthn` exporting what it always has.
export * from "../util/base64url.js";
export * from "./multikey.js";
export * from "./register.js";
