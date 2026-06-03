// Device — push wake-up control plane (binding https://trusttasks.org/binding/push/0.1).
//
//   - registerPushChannel  → device registers a push channel with the GATEWAY
//                            (push/register), gets an opaque WakeHandle.
//   - setDeviceWake        → device conveys that handle to its VTA
//                            (device/set-wake); the VTA owns the allowlist.

export * from "./register-gateway.js";
export * from "./set-wake.js";
