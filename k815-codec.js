/*
 * K815 codec: turns key bindings and lighting settings into the bytes the pad stores.
 * Pure functions only. No USB, no DOM, so it can be tested with `node test_web.js`.
 *
 * The pad keeps a 4 KB config memory. The parts we touch:
 *
 *   0x00-0x07  identity header (VID/PID). Never written.
 *   0x08-0x6F  settings: per-key type bytes, LED mode/colours/brightness, polling rate.
 *   0x6E-0x7A  pointers to the end of the macro area.
 *   0xA0-0x2CF key table: 4 profiles x 14 slots x 10 bytes. We use slots 0-7 of each profile.
 *   0x400-     macro area: one record per macro key.
 *
 * Reverse-engineered from the vendor's "Gaming Mouse 3.0.exe".
 */

// ---------- memory map ----------

const NUM_KEYS = 8;
const NUM_PROFILES = 4;
const HEADER_LEN = 0xa0; // everything before the key table
const KEY_TABLE_LEN = 0x230; // 4 profiles x 0x8C bytes
const PROFILE_STRIDE = 0x8c; // bytes between one profile's key slots and the next
const ENTRY_LEN = 10; // bytes per key slot
const MACRO_START = 0x400;
const MACRO_END_LIMIT = 0xf20; // macro area must stay below this

// Each key has a "type" byte per profile. Low 5 bits: what the key does. Top 3 bits: "button response" lighting.
const KEY_TYPE_MACRO = 0x0d; // on-device macro (also used for plain single keys)
const KEY_TYPE_MEDIA = 0x0f; // consumer-control key (volume, play/pause, ...)
const KEY_TYPE_MASK = 0x1f;
const REACT_ENABLE = 0x20; // bit 5
const REACT_STYLE_SHIFT = 6; // bits 6-7

// Type bytes of keys 0-7, for each of the 4 profiles.
const TYPE_ADDR = [0x08, 0x44, 0x50, 0x60].map((first) => [...Array(NUM_KEYS)].map((_, key) => first + key));

const MACRO_STEP_DELAY_MS = 20; // delay between key events, same as the vendor tool
const PRESS_FLAG = 0x80; // set on the delay byte of a key-down event

// ---------- key names ----------

const MODIFIERS = {
  ctrl: 0xe0, shift: 0xe1, alt: 0xe2, win: 0xe3,
  rctrl: 0xe4, rshift: 0xe5, ralt: 0xe6, rwin: 0xe7,
};

// Name -> USB HID keyboard usage code.
const KEYS = {
  ...MODIFIERS,
  enter: 0x28, esc: 0x29, backspace: 0x2a, tab: 0x2b, space: 0x2c,
  "-": 0x2d, "=": 0x2e, "[": 0x2f, "]": 0x30, "\\": 0x31,
  ";": 0x33, "'": 0x34, "`": 0x35, ",": 0x36, ".": 0x37, "/": 0x38,
  capslock: 0x39, printscreen: 0x46, scrolllock: 0x47, pause: 0x48,
  insert: 0x49, home: 0x4a, pageup: 0x4b, delete: 0x4c, end: 0x4d, pagedown: 0x4e,
  right: 0x4f, left: 0x50, down: 0x51, up: 0x52, menu: 0x65,
};
for (let i = 0; i < 26; i++) KEYS[String.fromCharCode(97 + i)] = 0x04 + i; // a-z
for (let digit = 0; digit <= 9; digit++) {
  const offsetFromOne = (digit + 9) % 10; // 1..9 then 0, as on a keyboard
  KEYS[digit] = 0x1e + offsetFromOne;
  KEYS["kp" + digit] = 0x59 + offsetFromOne; // numpad
}
for (let n = 1; n <= 24; n++) KEYS["f" + n] = n <= 12 ? 0x3a + n - 1 : 0x68 + n - 13;

// Name -> USB HID consumer-control usage code.
const MEDIA = {
  volup: 0xe9, voldown: 0xea, mute: 0xe2,
  playpause: 0xcd, next: 0xb5, prev: 0xb6, stop: 0xb7,
  calc: 0x192, mail: 0x18a, browser: 0x223, player: 0x183,
};

const normalizeSpec = (text) => text.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Turns a binding like "ctrl+shift+a", "ctrl+c ctrl+v" or "volup" into
 *   ["media", usage]                       or
 *   ["macro", [[isPress, hidCode], ...]]
 * Each space-separated combo presses its keys in order, then releases them in reverse.
 */
function parseBinding(spec) {
  if (Object.hasOwn(MEDIA, spec)) return ["media", MEDIA[spec]];

  const events = [];
  for (const combo of spec.split(" ")) {
    const codes = combo.split("+").map((name) => {
      if (!Object.hasOwn(KEYS, name)) throw new Error(`unknown key "${name}"`);
      return KEYS[name];
    });
    for (const code of codes) events.push([true, code]);
    for (const code of [...codes].reverse()) events.push([false, code]);
  }
  return ["macro", events];
}

// ---------- key bindings -> bytes ----------

const lowByte = (n) => n & 0xff;
const highByte6 = (n) => (n >> 8) & 0x3f; // addresses are 14 bit

/**
 * bindings: {keyIndex: spec}. Builds, for each bound key:
 *   types[key]    type byte (KEY_TYPE_*)
 *   entries[key]  its 10-byte key-table entry
 * plus `area`, the concatenated macro records.
 *
 * A macro record is [1, 0] (repeat once) followed by one (delay, hidCode) pair per event,
 * padded to a multiple of 8 bytes. The delay byte has PRESS_FLAG set for key-down.
 */
function buildBindings(bindings) {
  const types = {};
  const entries = {};
  const area = [];

  for (const [key, spec] of Object.entries(bindings)) {
    const [kind, value] = parseBinding(spec);
    const addr = MACRO_START + area.length;

    if (kind === "media") {
      types[key] = KEY_TYPE_MEDIA;
      entries[key] = [0, 0, 0, lowByte(value), value >> 8, lowByte(addr), highByte6(addr), 0, 0, 0];
      continue;
    }

    const events = value;
    const record = [1, 0];
    for (const [isPress, code] of events) {
      record.push(isPress ? PRESS_FLAG | MACRO_STEP_DELAY_MS : MACRO_STEP_DELAY_MS, code);
    }
    const count = events.length;
    types[key] = KEY_TYPE_MACRO;
    entries[key] = [0, count & 0x7f, 0, 0, 0, lowByte(addr), highByte6(addr), (count >> 7) & 0x3f, 0, 0];

    const padding = (8 - (record.length % 8)) % 8;
    area.push(...record, ...Array(padding).fill(0));
  }

  if (MACRO_START + area.length > MACRO_END_LIMIT) throw new Error("macros too long");
  return { types, entries, area };
}

/**
 * header: the pad's current bytes 0x00-0x9F. Returns what to write back:
 *   header  the same bytes with key types and macro-end pointers updated
 *   table   the 0x230-byte key table (the same bindings for all 4 profiles)
 *   area    the macro records, to be written at MACRO_START
 */
function buildKeyImage(header, bindings) {
  const { types, entries, area } = buildBindings(bindings);
  const newHeader = [...header];

  // Keep each type byte's top 3 bits (button-response lighting); replace the low 5.
  for (const profileAddrs of TYPE_ADDR) {
    profileAddrs.forEach((addr, key) => {
      newHeader[addr] = (newHeader[addr] & ~KEY_TYPE_MASK & 0xff) | (types[key] ?? 0);
    });
  }

  const table = Array(KEY_TABLE_LEN).fill(0);
  for (let profile = 0; profile < NUM_PROFILES; profile++) {
    for (const [key, entry] of Object.entries(entries)) {
      table.splice(profile * PROFILE_STRIDE + key * ENTRY_LEN, ENTRY_LEN, ...entry);
    }
  }

  // The vendor tool lays out four empty per-profile tables right after the macros, 8 bytes apart.
  const macroEnd = MACRO_START + area.length;
  const [t1, t2, t3, t4] = [8, 16, 24, 32].map((offset) => macroEnd + offset);
  newHeader.splice(0x6e, 2, lowByte(macroEnd), macroEnd >> 8);
  newHeader.splice(0x70, 6, lowByte(t1), t1 >> 8, lowByte(t2), t2 >> 8, lowByte(t3), t3 >> 8);
  newHeader.splice(0x78, 3, 0, lowByte(t4), highByte6(t4));

  return { header: newHeader, table, area };
}

// ---------- lighting -> bytes ----------

// Firmware mode numbers. Other firmware modes exist but just render as static on this pad.
const LED_MODES = { breathe: 0, cycle: 1, static: 2, fade: 6, react: 1 };

const SETTINGS_BASE = 0x08; // `settings` arrays start at this address
const LED_MODE_ADDR = 0x1c; // mode << 4 | reactFlag << 3 | speed
const LED_MODE_BIT3_ADDR = 0x3b; // bit 7 is bit 3 of the mode; none of our modes use it
const LED_BRIGHTNESS_ADDR = 0x3f; // bits 4-6: dimming, 0 = brightest .. 6 = faintest
const USER_COLOR_SLOTS = 7; // used by breathe/cycle/fade/static
const DPI_COLOR_SLOTS = 6; // used by the pad's DPI-indicator mode; we fill them too so every mode agrees

/**
 * Where colour channel `channel` (3 * slot + 0/1/2 for r/g/b) lives:
 * [address, bit shift of its 4-bit nibble]. DPI colours use low nibbles, user colours high nibbles.
 */
function colorNibbleAddr(channel, isUserColor) {
  if (channel < 16) return [0x20 + channel, isUserColor ? 4 : 0];
  if (channel < 18) return [0x38 + channel - 16, isUserColor ? 4 : 0];
  return [[0x3e, 4], [0x3e, 0], [0x3f, 0]][channel - 18]; // last user colour is packed into 0x3E/0x3F
}

/**
 * settings: the pad's bytes 0x08-0x6F. colors: [[r, g, b], ...] with 0-255 channels,
 * repeated to fill all slots. dim: 0 (brightest) to 6. speed: 0 (slow) to 6.
 * reactStyle (react mode only): 0 breathing, 1 flowing water, 2 comet, 3 mono water.
 * Returns the edited settings plus the firmware mode and react flag (needed for ledLiveReport).
 */
function buildLedSettings(settings, mode, colors, dim, speed, reactStyle) {
  const out = [...settings];
  const at = (addr) => addr - SETTINGS_BASE;
  const firmwareMode = LED_MODES[mode];
  const reactFlag = mode === "react" ? 1 : 0;

  // The pad stores each channel inverted, as a 4-bit value.
  const nibbles = colors.map((rgb) => rgb.map((value) => (255 - value) >> 4));
  for (const [isUserColor, slotCount] of [[true, USER_COLOR_SLOTS], [false, DPI_COLOR_SLOTS]]) {
    for (let slot = 0; slot < slotCount; slot++) {
      nibbles[slot % nibbles.length].forEach((nibble, channelInSlot) => {
        const [addr, shift] = colorNibbleAddr(3 * slot + channelInSlot, isUserColor);
        out[at(addr)] = (out[at(addr)] & ~(0xf << shift) & 0xff) | (nibble << shift);
      });
    }
  }

  if (reactFlag) {
    for (const profileAddrs of TYPE_ADDR) {
      for (const addr of profileAddrs) {
        out[at(addr)] =
          (out[at(addr)] & KEY_TYPE_MASK) | REACT_ENABLE | ((reactStyle & 3) << REACT_STYLE_SHIFT);
      }
    }
  }

  out[at(LED_MODE_ADDR)] = (firmwareMode << 4) | (reactFlag << 3) | (speed & 7);
  out[at(LED_MODE_BIT3_ADDR)] &= 0x7f;
  out[at(LED_BRIGHTNESS_ADDR)] = (out[at(LED_BRIGHTNESS_ADDR)] & 0x8f) | ((dim & 7) << 4);

  return { settings: out, firmwareMode, reactFlag };
}

/**
 * Report body (without report ID) that applies LED settings immediately, without saving them.
 * Colour mask 0x7F = all 7 user colour slots; the 0x80 bit marks it as a colour-mask command.
 */
function ledLiveReport(firmwareMode, speed, dim, reactFlag) {
  const ALL_COLORS = 0x80 | 0x7f;
  const modeByte = (0x80 + (firmwareMode << 4) + reactFlag * 8 + (speed & 7)) & 0xff;
  const modeBit3 = ((firmwareMode >> 3) & 1) << 7;
  return [0x13, ALL_COLORS, modeByte, 0x0f, dim & 7, modeBit3 | 0x03, 0xff];
}

// USB polling rate (Hz) -> byte stored at 0x1E (the interval in ms, minus 1).
const POLL_RATES = { 125: 7, 250: 3, 500: 1, 1000: 0 };
const POLL_ADDR = 0x1e;

// ---------- bytes -> settings (reading the pad back) ----------

const KEY_NAME_BY_HID_CODE = Object.fromEntries(Object.entries(KEYS).map(([name, code]) => [code, name]));
const MEDIA_NAMES_BY_USAGE = Object.fromEntries(Object.entries(MEDIA).map(([name, usage]) => [usage, name]));

/**
 * Inverse of parseBinding for macro events [[isPress, hidCode], ...].
 * Only understands what our encoder writes: runs of key-downs followed by the matching key-ups in reverse.
 * Returns the binding text, or null for anything else (a macro made by other software).
 */
function eventsToBinding(events) {
  const steps = events.map(([isPress, code]) => [isPress, KEY_NAME_BY_HID_CODE[code]]);
  if (!steps.length || steps.some(([, name]) => name === undefined)) return null;

  const combos = [];
  let i = 0;
  while (i < steps.length) {
    const down = [];
    const up = [];
    while (i < steps.length && steps[i][0]) down.push(steps[i++][1]);
    while (i < steps.length && !steps[i][0]) up.push(steps[i++][1]);
    if (!down.length || up.join("+") !== [...down].reverse().join("+")) return null;
    combos.push(down.join("+"));
  }
  return combos.join(" ");
}

/**
 * header: pad bytes 0x00-0x9F. entries: bytes at HEADER_LEN, at least 8 x ENTRY_LEN (profile 0).
 * macros: bytes from MACRO_START up to the macro-end pointer.
 * Returns {bindings: [text per key, "" if none], unrecognised: [key indexes]}.
 */
function decodeBindings(header, entries, macros) {
  const bindings = [];
  const unrecognised = [];

  for (let key = 0; key < NUM_KEYS; key++) {
    const type = header[TYPE_ADDR[0][key]] & KEY_TYPE_MASK;
    const entry = entries.slice(key * ENTRY_LEN, (key + 1) * ENTRY_LEN);
    let binding = "";

    if (type === KEY_TYPE_MEDIA) {
      binding = MEDIA_NAMES_BY_USAGE[entry[3] | (entry[4] << 8)] ?? null;
    } else if (type === KEY_TYPE_MACRO) {
      const count = (entry[1] & 0x7f) | ((entry[7] & 0x3f) << 7);
      const start = ((entry[5] | (entry[6] << 8)) & 0x3fff) - MACRO_START + 2; // skip the [repeat, 0] record header
      const pairs = macros.slice(start, start + count * 2);
      if (start >= 2 && pairs.length === count * 2) {
        const events = [];
        for (let i = 0; i < pairs.length; i += 2) events.push([(pairs[i] & PRESS_FLAG) !== 0, pairs[i + 1]]);
        binding = eventsToBinding(events);
      } else {
        binding = null;
      }
    } else if (type !== 0) {
      binding = null;
    }

    if (binding === null) {
      unrecognised.push(key);
      binding = "";
    }
    bindings.push(binding);
  }
  return { bindings, unrecognised };
}

const toHex = ([r, g, b]) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

/**
 * header: pad bytes 0x00-0x9F. Returns {mode, colors: ["#rrggbb"], speed, brightness, reactStyle},
 * or null if the pad is in a firmware mode this app doesn't produce. Colours come back rounded to
 * the pad's 4 bits per channel.
 */
function decodeLighting(header) {
  const modeByte = header[LED_MODE_ADDR];
  const firmwareMode = (modeByte >> 4) | ((header[LED_MODE_BIT3_ADDR] >> 7) << 3);
  const reactFlag = (modeByte >> 3) & 1;
  const name = reactFlag
    ? firmwareMode === LED_MODES.react ? "react" : null
    : Object.keys(LED_MODES).find((m) => m !== "react" && LED_MODES[m] === firmwareMode) ?? null;
  if (!name) return null;

  // Undo the inversion: nibble n was stored as (255 - value) >> 4.
  const slots = [];
  for (let slot = 0; slot < USER_COLOR_SLOTS; slot++) {
    slots.push([0, 1, 2].map((c) => {
      const [addr, shift] = colorNibbleAddr(3 * slot + c, true);
      return (15 - ((header[addr] >> shift) & 0xf)) * 17;
    }));
  }
  // We fill all 7 slots by repeating the chosen colours, so the colours are the shortest repeating prefix.
  let period = 1;
  while (period < slots.length && !slots.every((c, j) => c.join() === slots[j % period].join())) period++;
  const multi = name === "cycle" || name === "fade" || name === "react";
  const colors = slots.slice(0, multi ? period : 1);

  const isDark = colors.length === 1 && colors[0].every((v) => v === 0);
  return {
    mode: name === "static" && isDark ? "off" : name,
    colors: colors.map(toHex),
    speed: Math.min(header[LED_MODE_ADDR] & 7, 6),
    brightness: Math.max(1, 7 - ((header[LED_BRIGHTNESS_ADDR] >> 4) & 7)),
    reactStyle: (header[TYPE_ADDR[0][0]] >> REACT_STYLE_SHIFT) & 3,
  };
}

const decodePollRate = (header) => Number(Object.keys(POLL_RATES).find((hz) => POLL_RATES[hz] === header[POLL_ADDR])) || 0;

const K815 = {
  NUM_KEYS, HEADER_LEN, KEY_TABLE_LEN, MACRO_START, SETTINGS_BASE, POLL_ADDR,
  TYPE_ADDR, KEYS, MODIFIERS, MEDIA, LED_MODES, POLL_RATES,
  normalizeSpec, parseBinding, buildBindings, buildKeyImage,
  colorNibbleAddr, buildLedSettings, ledLiveReport,
  decodeBindings, decodeLighting, decodePollRate, MACRO_END_LIMIT, ENTRY_LEN,
};
