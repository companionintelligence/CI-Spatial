// BLE + DUML constants for the Osmo family. Confidence level noted per source's own caveats
// (see ../README.md "Protocol notes" for the full research writeup) — nothing here has been
// verified against an actual Osmo Mobile 6 yet; this is the best synthesis of Osmo Pocket 3 /
// Osmo Action reverse-engineering, which shares DJI's common DUML framing.

// 16-bit short forms (used to match against noble's characteristic.uuid, which normalizes
// to lowercase dashless short form for base-UUID-derived characteristics).
export const CHAR_SHORT = { FFF0: 'fff0', FFF3: 'fff3', FFF4: 'fff4', FFF5: 'fff5' };
export const SERVICE_SHORT = 'fff0';

// Full 128-bit forms, derived from the Bluetooth base UUID. Web Bluetooth also accepts the
// bare 16-bit integer (e.g. 0xfff0) directly in filters/optionalServices/getCharacteristic —
// browser code may use either form.
export const SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
export const CHAR = {
  FFF0: '0000fff0-0000-1000-8000-00805f9b34fb', // no distinct role observed; subscribed defensively
  FFF3: '0000fff3-0000-1000-8000-00805f9b34fb', // fallback write characteristic (older/other Osmo models)
  FFF4: '0000fff4-0000-1000-8000-00805f9b34fb', // pairing-trigger write target + primary notify source
  FFF5: '0000fff5-0000-1000-8000-00805f9b34fb', // primary write characteristic (Wireshark-verified vs Mimo)
};

export const ALL_NOTIFY_CHARS_SHORT = [CHAR_SHORT.FFF0, CHAR_SHORT.FFF3, CHAR_SHORT.FFF4, CHAR_SHORT.FFF5];

// Sources disagree on which characteristic actually accepts DUML writes (fff5 confirmed for
// Osmo Pocket 3 via Wireshark; fff3 is the older node-osmo guess, flagged by lib-osmo-ble's
// own authors as "may work on Osmo Mobile"). Try in this order and latch whichever the device
// answers on.
export const WRITE_CHAR_CANDIDATES = [
  { uuid: CHAR_SHORT.FFF5, withResponse: false },
  { uuid: CHAR_SHORT.FFF3, withResponse: true },
];

// Same candidates, full 128-bit form — Web Bluetooth's characteristic.uuid is always the
// canonical full UUID, never the short form noble uses. Use this list (not the short one
// above) when matching against BluetoothRemoteGATTCharacteristic.uuid in browser code.
export const WRITE_CHAR_CANDIDATES_FULL = [
  { uuid: CHAR.FFF5, withResponse: false },
  { uuid: CHAR.FFF3, withResponse: true },
];

export const PAIRING_TRIGGER_CHAR_SHORT = CHAR_SHORT.FFF4;
export const PAIRING_TRIGGER_BYTES = Uint8Array.from([0x01, 0x00]);

// DJI's BLE manufacturer-data company-id prefix, used to recognize a DJI device while
// scanning (bytes 0-1 of manufacturerData).
export const DJI_MANUFACTURER_PREFIX = Uint8Array.from([0xaa, 0x08]);

/** DUML component/subsystem addresses. */
export const COMPONENT = {
  CAMERA: 0x01,
  APP: 0x02,
  GIMBAL: 0x03,
  FLIGHT_CONTROLLER: 0x04,
  WIFI: 0x07,
  BATTERY: 0x09,
  PAIRER: 0x88,
};

/** DUML flags byte. */
export const FLAGS = {
  NOTIFY: 0x00,
  REQUEST: 0x40,
  RESPONSE: 0x80,
  ACK_RESPONSE: 0xc0,
};

/** DUML command-set (cmdSet) groups. */
export const CMD_SET = {
  CORE: 0x00,
  INFO: 0x01,
  CAMERA: 0x02,
  FLIGHT_CTRL: 0x03,
  GIMBAL_FN: 0x04,
  RC: 0x06,
  WIFI: 0x07,
  CONFIG: 0x08,
  BATTERY: 0x0d,
};

export const CMD_ID = {
  SET_PAIRING_PIN: 0x45,
  PAIRING_PIN_APPROVED: 0x46,
  // Corrected/extended against real cmdSet/cmdId values mined from libdjisdk_jni.so (DJI's
  // C++ SDK core, decompiled from the Mimo APK) — cmdSet/cmdId survive as C++ template
  // non-type parameters in mangled symbol names even in a stripped binary, e.g.
  // dji::core::dji_cmd_base_req<1, 0x04, 0x58, ...>. See ../README.md for the full mapping.
  GIMBAL_STICK_CONTROL_ENABLE: 0x58, // dji_gimbal_set_stick_control_enable — HANDHELD-specific per class hierarchy (HandheldGimbalAbstraction), bound to KeyHandheldStickPositionPush/KeyStickGimbalControlEnabledPush. Best candidate for a required "arm joystick control" precondition before speed/angle commands are honored — untested.
  GIMBAL_SPEED_CTRL: 0x0c, // dji_gimbal_set_cmd_custom_ctrl_speed — confirmed by SDK naming (set_gimbal_control_gimbal_speed)
  GIMBAL_ANGLE_SET: 0x0a, // dji_gimbal_set_control_gimbal_angle — the BASE angle command (has a "_new" struct variant); NOT the same wire struct as GIMBAL_ABS_ANGLE below
  GIMBAL_ABS_ANGLE: 0x14, // dji_gimbal_set_control_gimbal_angle_ex — an "extended" angle variant, distinct payload from the base 0x0A command per SDK naming
  GIMBAL_SET_WORK_MODE: 0x44, // dji_gimbal_set_gimbal_work_mode (SDK alias literally "set_gimbal_mode") — the TRUE mode-set command; the previous guess of 0x4C for this was wrong
  GIMBAL_RESET_AND_CENTER: 0x4c, // dji_gimbal_set_work_mode_and_return_center (SDK alias "action_gimbal_set_reset") — a reset/recenter action, NOT a generic mode-set despite prior assumption
};

export const GIMBAL_MODE = { LOCK: 0, FOLLOW: 1, FPV: 2 };

// djictl/lib-osmo-ble both default to this literal identifier string for the pairing
// request; it's just an app-instance id, not a secret.
export const DEFAULT_IDENTIFIER = '001749319286102';
