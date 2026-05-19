//! WASM bindings over `affinidi-messaging-didcomm`.
//!
//! Private keys live in WASM linear memory once unlocked, behind the
//! opaque `Identity` handle — JS only sees the handle (a u32 index
//! into Rust-side storage) and the ciphertext that `pack*` returns.
//! Plaintext private-key bytes never cross the wasm-bindgen boundary
//! except at `Identity::fromSecretJwk` time, where the caller is
//! responsible for zeroising the JWK after passing it in.

use affinidi_messaging_didcomm::Message;
use affinidi_messaging_didcomm::crypto::key_agreement::{
    Curve, PrivateKeyAgreement, PublicKeyAgreement,
};
use affinidi_messaging_didcomm::message::forward::wrap_in_forward;
use affinidi_messaging_didcomm::message::pack::{
    pack_encrypted_anoncrypt, pack_encrypted_authcrypt,
};
use affinidi_messaging_didcomm::message::unpack::{UnpackResult, unpack as didcomm_unpack};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

fn err<E: std::fmt::Display>(prefix: &str, e: E) -> JsError {
    JsError::new(&format!("{prefix}: {e}"))
}

/// Serialize a value as a plain JS object (rather than a JS `Map`,
/// which is what `serde_wasm_bindgen` produces by default for
/// dictionary-shaped data). Plain objects are what consumers expect
/// when doing `result.message.type`.
fn to_plain_js<T: Serialize>(value: &T) -> Result<JsValue, serde_wasm_bindgen::Error> {
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true);
    value.serialize(&serializer)
}

fn parse_curve(s: &str) -> Result<Curve, JsError> {
    match s {
        "X25519" => Ok(Curve::X25519),
        "P-256" | "P256" => Ok(Curve::P256),
        "secp256k1" | "K-256" | "K256" => Ok(Curve::K256),
        other => Err(JsError::new(&format!("unsupported curve: {other}"))),
    }
}

// ---------------------------------------------------------------------------
// Identity: opaque handle wrapping PrivateKeyAgreement + kid metadata.
// ---------------------------------------------------------------------------

/// Private DIDComm identity. Holds the X25519 (or P-256 / K-256)
/// key-agreement private key plus the DID and key-agreement `kid`.
///
/// JS holds a `Identity` handle; the private bytes never leave WASM
/// linear memory after construction. `dispose()` (or letting the JS
/// handle get GC'd) zeroises the private key via the dalek crate's
/// `ZeroizeOnDrop`.
#[wasm_bindgen]
pub struct Identity {
    did: String,
    key_agreement_kid: String,
    key_agreement_private: PrivateKeyAgreement,
}

#[derive(Deserialize)]
struct SecretJwkInput {
    did: String,
    kid: String,
    jwk: serde_json::Value,
}

#[derive(Serialize)]
struct PublicJwkOutput {
    kid: String,
    jwk: serde_json::Value,
}

#[wasm_bindgen]
impl Identity {
    /// Generate a fresh identity with random keys on the chosen curve.
    /// Curve defaults to `"X25519"` (recommended for DIDComm v2).
    #[wasm_bindgen(js_name = generate)]
    pub fn generate(did: String, curve: Option<String>) -> Result<Identity, JsError> {
        let curve = curve.as_deref().unwrap_or("X25519");
        let curve = parse_curve(curve)?;
        let key_agreement_private = PrivateKeyAgreement::generate(curve);
        let key_agreement_kid = format!("{did}#key-agreement-1");
        Ok(Identity {
            did,
            key_agreement_kid,
            key_agreement_private,
        })
    }

    /// Reconstruct an identity from a secret JWK. The caller is
    /// responsible for zeroising the JWK after this call returns —
    /// JS strings are immutable, so this is best-effort.
    #[wasm_bindgen(js_name = fromSecretJwk)]
    pub fn from_secret_jwk(input: JsValue) -> Result<Identity, JsError> {
        let SecretJwkInput { did, kid, jwk } =
            serde_wasm_bindgen::from_value(input).map_err(|e| err("invalid input", e))?;

        // Pull `d` out of the JWK and decode the raw secret bytes.
        let d_b64 = jwk
            .get("d")
            .and_then(|v| v.as_str())
            .ok_or_else(|| JsError::new("JWK missing `d` (private scalar)"))?;
        let crv = jwk
            .get("crv")
            .and_then(|v| v.as_str())
            .ok_or_else(|| JsError::new("JWK missing `crv`"))?;
        let curve = parse_curve(crv)?;

        use base64ct::{Base64UrlUnpadded, Encoding};
        let raw = Base64UrlUnpadded::decode_vec(d_b64).map_err(|e| err("decode `d`", e))?;
        let key_agreement_private = PrivateKeyAgreement::from_raw_bytes(curve, &raw)
            .map_err(|e| err("from_raw_bytes", e))?;
        Ok(Identity {
            did,
            key_agreement_kid: kid,
            key_agreement_private,
        })
    }

    #[wasm_bindgen(getter)]
    pub fn did(&self) -> String {
        self.did.clone()
    }

    #[wasm_bindgen(getter, js_name = keyAgreementKid)]
    pub fn key_agreement_kid(&self) -> String {
        self.key_agreement_kid.clone()
    }

    /// Export the public counterpart as a JWK (`kty`/`crv`/`x`(/`y`)).
    /// Suitable for publishing in the DID document.
    #[wasm_bindgen(js_name = publicJwk)]
    pub fn public_jwk(&self) -> Result<JsValue, JsError> {
        let pk = self.key_agreement_private.public_key();
        let out = PublicJwkOutput {
            kid: self.key_agreement_kid.clone(),
            jwk: pk.to_jwk(),
        };
        to_plain_js(&out).map_err(|e| err("publicJwk", e))
    }

    /// Drop the private key. After this the handle is unusable. Calls
    /// to `pack*`/`unpack` referencing it from JS will already have
    /// failed at the borrow-check level once the handle is gone.
    pub fn dispose(self) {
        // moves self → drops → ZeroizeOnDrop fires on the private key
    }
}

// ---------------------------------------------------------------------------
// Recipients and pack/unpack
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RecipientInput {
    kid: String,
    jwk: serde_json::Value,
}

fn parse_recipients(input: JsValue) -> Result<Vec<(String, PublicKeyAgreement)>, JsError> {
    let parsed: Vec<RecipientInput> =
        serde_wasm_bindgen::from_value(input).map_err(|e| err("recipients", e))?;
    parsed
        .into_iter()
        .map(|r| {
            let pk = PublicKeyAgreement::from_jwk(&r.jwk).map_err(|e| err("recipient JWK", e))?;
            Ok((r.kid, pk))
        })
        .collect()
}

#[derive(Deserialize)]
struct PlaintextInput {
    id: Option<String>,
    r#type: String,
    from: Option<String>,
    to: Option<Vec<String>>,
    body: serde_json::Value,
    #[serde(default)]
    thid: Option<String>,
}

fn build_message(input: PlaintextInput) -> Message {
    let mut msg = match input.id {
        Some(id) => Message::build(id, input.r#type, input.body).finalize(),
        None => Message::new(input.r#type, input.body),
    };
    if let Some(from) = input.from {
        msg = msg.from(from);
    }
    if let Some(to) = input.to {
        msg = msg.to(to);
    }
    if let Some(thid) = input.thid {
        msg.thid = Some(thid);
    }
    msg
}

/// Build a DIDComm v2 plaintext message and return it as JSON.
#[wasm_bindgen(js_name = buildPlaintextMessage)]
pub fn build_plaintext_message(input: JsValue) -> Result<String, JsError> {
    let input: PlaintextInput =
        serde_wasm_bindgen::from_value(input).map_err(|e| err("invalid input", e))?;
    let msg = build_message(input);
    serde_json::to_string(&msg).map_err(|e| err("serialize", e))
}

/// Pack a DIDComm v2 message as **authcrypt** (sender authenticated).
/// `recipients` is `[{ kid, jwk }, …]` where each `jwk` is the
/// recipient's key-agreement public key in JWK form.
#[wasm_bindgen(js_name = packAuthcrypt)]
pub fn pack_authcrypt(
    message: JsValue,
    sender: &Identity,
    recipients: JsValue,
) -> Result<String, JsError> {
    let input: PlaintextInput =
        serde_wasm_bindgen::from_value(message).map_err(|e| err("invalid message", e))?;
    let msg = build_message(input);
    let rs = parse_recipients(recipients)?;
    let rs_refs: Vec<(&str, &PublicKeyAgreement)> =
        rs.iter().map(|(k, p)| (k.as_str(), p)).collect();
    pack_encrypted_authcrypt(
        &msg,
        &sender.key_agreement_kid,
        &sender.key_agreement_private,
        &rs_refs,
    )
    .map_err(|e| err("pack authcrypt", e))
}

/// Pack a DIDComm v2 message as **anoncrypt** (no sender identity).
#[wasm_bindgen(js_name = packAnoncrypt)]
pub fn pack_anoncrypt(message: JsValue, recipients: JsValue) -> Result<String, JsError> {
    let input: PlaintextInput =
        serde_wasm_bindgen::from_value(message).map_err(|e| err("invalid message", e))?;
    let msg = build_message(input);
    let rs = parse_recipients(recipients)?;
    let rs_refs: Vec<(&str, &PublicKeyAgreement)> =
        rs.iter().map(|(k, p)| (k.as_str(), p)).collect();
    pack_encrypted_anoncrypt(&msg, &rs_refs).map_err(|e| err("pack anoncrypt", e))
}

/// Pack an already-serialized DIDComm Message JSON as anoncrypt.
/// Use this when the message has fields the builder shape doesn't
/// carry — notably the `attachments` that `wrapForward` puts in the
/// envelope. The full Message serde shape round-trips intact here.
#[wasm_bindgen(js_name = packAnoncryptJson)]
pub fn pack_anoncrypt_json(message_json: String, recipients: JsValue) -> Result<String, JsError> {
    let msg: Message =
        serde_json::from_str(&message_json).map_err(|e| err("parse message JSON", e))?;
    let rs = parse_recipients(recipients)?;
    let rs_refs: Vec<(&str, &PublicKeyAgreement)> =
        rs.iter().map(|(k, p)| (k.as_str(), p)).collect();
    pack_encrypted_anoncrypt(&msg, &rs_refs).map_err(|e| err("pack anoncrypt json", e))
}

/// Pack an already-serialized DIDComm Message JSON as authcrypt.
/// Sibling of `packAnoncryptJson` for messages whose shape exceeds
/// the builder (attachments, custom extras) and whose sender must be
/// authenticated. The pickup/3.0/delivery envelope is the primary
/// use case — its attachments don't survive the builder path.
#[wasm_bindgen(js_name = packAuthcryptJson)]
pub fn pack_authcrypt_json(
    message_json: String,
    sender: &Identity,
    recipients: JsValue,
) -> Result<String, JsError> {
    let msg: Message =
        serde_json::from_str(&message_json).map_err(|e| err("parse message JSON", e))?;
    let rs = parse_recipients(recipients)?;
    let rs_refs: Vec<(&str, &PublicKeyAgreement)> =
        rs.iter().map(|(k, p)| (k.as_str(), p)).collect();
    pack_encrypted_authcrypt(
        &msg,
        &sender.key_agreement_kid,
        &sender.key_agreement_private,
        &rs_refs,
    )
    .map_err(|e| err("pack authcrypt json", e))
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum UnpackOutput {
    Encrypted {
        message: serde_json::Value,
        authenticated: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        sender_kid: Option<String>,
        recipient_kid: String,
    },
    Signed {
        message: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        signer_kid: Option<String>,
    },
    Plaintext {
        message: serde_json::Value,
    },
}

#[derive(Deserialize)]
struct UnpackInput {
    input: String,
    #[serde(default)]
    sender_public_jwk: Option<serde_json::Value>,
}

/// Auto-detect and unpack a DIDComm v2 message. For JWE
/// (encrypted), `recipient` is required; for authcrypt, also pass
/// `sender_public_jwk` so the JWE's sender-binding can be verified.
/// For JWS (signed) messages, a verifying key would be needed —
/// not yet exposed here.
///
/// `recipient` is borrowed (`&Identity`); the JS handle remains
/// usable after this call. Pass a sentinel like a freshly-generated
/// identity if you genuinely need plaintext-only unpacking — that
/// path can be added as a dedicated function later.
#[wasm_bindgen(js_name = unpack)]
pub fn unpack(input: JsValue, recipient: &Identity) -> Result<JsValue, JsError> {
    let UnpackInput {
        input,
        sender_public_jwk,
    } = serde_wasm_bindgen::from_value(input).map_err(|e| err("invalid input", e))?;

    let sender_pub = sender_public_jwk
        .as_ref()
        .map(PublicKeyAgreement::from_jwk)
        .transpose()
        .map_err(|e| err("sender JWK", e))?;

    let result = didcomm_unpack(
        &input,
        Some(&recipient.key_agreement_kid),
        Some(&recipient.key_agreement_private),
        sender_pub.as_ref(),
        None,
    )
    .map_err(|e| err("unpack", e))?;

    let out = match result {
        UnpackResult::Encrypted {
            message,
            authenticated,
            sender_kid,
            recipient_kid,
        } => UnpackOutput::Encrypted {
            message: serde_json::to_value(&message).map_err(|e| err("encode", e))?,
            authenticated,
            sender_kid,
            recipient_kid,
        },
        UnpackResult::Signed {
            message,
            signer_kid,
        } => UnpackOutput::Signed {
            message: serde_json::to_value(&message).map_err(|e| err("encode", e))?,
            signer_kid,
        },
        UnpackResult::Plaintext(message) => UnpackOutput::Plaintext {
            message: serde_json::to_value(&message).map_err(|e| err("encode", e))?,
        },
    };

    to_plain_js(&out).map_err(|e| err("encode output", e))
}

/// Wrap an already-encrypted JWE in a DIDComm Routing 2.0 forward
/// envelope. Returns the **plaintext** forward message JSON — the
/// caller is expected to immediately anoncrypt it to the mediator's
/// key agreement key via `packAnoncrypt` before transmitting.
///
/// Layered composition: `pack* (inner) → wrapForward (envelope) →
/// packAnoncrypt (outer for mediator) → mediator delivers inner to
/// `next` DID`.
#[wasm_bindgen(js_name = wrapForward)]
pub fn wrap_forward(next: String, encrypted_jwe: String) -> Result<String, JsError> {
    let msg = wrap_in_forward(&next, &encrypted_jwe).map_err(|e| err("wrap_in_forward", e))?;
    serde_json::to_string(&msg).map_err(|e| err("serialize forward", e))
}

/// Return the linked `affinidi-messaging-didcomm` crate version.
#[wasm_bindgen(js_name = didcommCrateVersion)]
pub fn didcomm_crate_version() -> String {
    "0.13".to_string()
}
