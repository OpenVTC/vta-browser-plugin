//! WASM bindings over `affinidi-messaging-didcomm`.
//!
//! The current surface is intentionally tiny — one round-trip through
//! the `Message` type — just enough to prove the build pipeline.
//! Authcrypt / anoncrypt / forward bindings land in the next step
//! once we've validated the WASM bundle loads in the PWA and the
//! extension's MV3 popup.

use affinidi_messaging_didcomm::Message;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Plaintext-message inputs from JS.
#[derive(serde::Deserialize)]
pub struct BuildPlaintextInput {
    pub id: Option<String>,
    pub r#type: String,
    pub from: Option<String>,
    pub to: Option<Vec<String>>,
    pub body: serde_json::Value,
}

/// Build a DIDComm v2 plaintext message and return it as JSON.
///
/// This exercises `affinidi-messaging-didcomm`'s `Message` type
/// through wasm-bindgen + `serde_json` round-tripping. No crypto,
/// no I/O — purely a build-pipeline smoke test.
#[wasm_bindgen(js_name = buildPlaintextMessage)]
pub fn build_plaintext_message(input: JsValue) -> Result<String, JsError> {
    let input: BuildPlaintextInput = serde_wasm_bindgen::from_value(input)
        .map_err(|e| JsError::new(&format!("invalid input: {e}")))?;
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
    serde_json::to_string(&msg).map_err(|e| JsError::new(&format!("serialize: {e}")))
}

/// Return the linked `affinidi-messaging-didcomm` crate version. Lets
/// the JS side log which DIDComm runtime is in use without parsing
/// `package.json`.
#[wasm_bindgen(js_name = didcommCrateVersion)]
pub fn didcomm_crate_version() -> String {
    // The dep version isn't directly introspectable at runtime; we record
    // the pinned-at-build-time value here. Keep in sync with Cargo.toml.
    "0.13".to_string()
}
