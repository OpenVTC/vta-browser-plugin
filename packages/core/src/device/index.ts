// Device — push wake-up control plane (binding https://trusttasks.org/binding/push/0.1).
//
//   - registerPushChannel  → device registers a push channel with the GATEWAY
//                            (push/register), gets an opaque WakeHandle.
//   - setDeviceWake        → device conveys that handle to its VTA
//                            (device/set-wake); the VTA owns the allowlist.

//   - registerDevice       → device enrols with its agent (device/register)
//   - deviceHeartbeat      → device stays enrolled, and collects queued work
//                            (device/heartbeat) — including a pending wipe
//   - pushWake             → spend a WakeHandle to wake a device. The sender
//                            is the controller agent, not the device.

export * from "./enrolment.js";
export * from "./wake.js";
export * from "./register-gateway.js";
export * from "./set-wake.js";
