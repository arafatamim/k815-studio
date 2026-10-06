/*
 * K815 Studio UI. Talks to the pad through the functions in k815-device.js
 * and encodes through K815 (k815-codec.js). Sections:
 *   1. state          4. keys tab        7. pad preview
 *   2. small helpers  5. light tab       8. connection
 *   3. tabs           6. device tab      9. start-up
 */

// ============ 1. state ============

const DEFAULT_STATE = {
  profiles: Array.from({ length: K815.NUM_PROFILES }, () => Array(K815.NUM_KEYS).fill("")),
  selectedProfile: 0, // which profile the Keys tab is editing
  activeProfile: 0, // the profile the pad last told us it is using
  selectedKey: 0,
  activeTab: "keys",
  lightMode: "static",
  colors: ["#ff4f12"],
  speed: 3, // 0 slow .. 6 fast
  brightness: 7, // 1 dim .. 7 bright
  reactStyle: 0,
  pollRate: 0, // Hz as last read from the pad, 0 = unknown
};

/** Four lists of NUM_KEYS specs ("" = unassigned), whatever shape storage was in. */
function normaliseProfiles(profiles) {
  return Array.from({ length: K815.NUM_PROFILES }, (_, profile) =>
    Array.from({ length: K815.NUM_KEYS }, (_, key) => profiles?.[profile]?.[key] || ""),
  );
}

// Saved in this browser so your layout is still here next visit. Never leaves the machine.
const STORAGE_KEY = "k815";
let state = { ...DEFAULT_STATE };
try {
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  const saved = stored && typeof stored === "object" ? stored : {};
  // Older versions stored a single flat keyBindings list. It becomes Profile 1, cloned into the
  // other three, so the first write under the new layout leaves the pad behaving as it did.
  if (Array.isArray(saved.keyBindings) && !saved.profiles) {
    saved.profiles = Array.from({ length: K815.NUM_PROFILES }, () => [...saved.keyBindings]);
    delete saved.keyBindings;
  }
  state = { ...DEFAULT_STATE, ...saved, profiles: normaliseProfiles(saved.profiles) };
} catch {
  // storage unavailable or corrupted: run with defaults
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // storage unavailable: nothing to do
  }
}

let isBusy = false; // true while a write/read to the pad is running

// Keys whose binding on the pad isn't something this page can show (e.g. a macro made by other software),
// per profile. Not saved: it describes the pad, which is re-read on every connect.
let unrecognised = Array.from({ length: K815.NUM_PROFILES }, () => []);

// ============ 2. small helpers ============

const byId = (id) => document.getElementById(id);

/** The bindings the Keys tab is editing. */
const currentBindings = () => state.profiles[state.selectedProfile];

/** Which of that profile's keys hold macros this page can't show. */
const currentUnrecognised = () => unrecognised[state.selectedProfile];

const hexToRgb = (hex) => [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** Renders [[value, title, description?], ...] as a row of toggle tiles; `current` is highlighted. */
function tileButtons(items, current, dataAttribute) {
  return items
    .map(([value, title, description]) => {
      const selected = String(value) === String(current) ? "on" : "";
      const small = description ? `<small>${description}</small>` : "";
      return `<button class="tile ${selected}" data-${dataAttribute}="${value}"><b>${title}</b>${small}</button>`;
    })
    .join("");
}

function setStatus(text, kind = "") {
  byId("statusMsg").textContent = text;
  byId("statusBar").className = kind; // "", "ok" or "err"
}

/** Runs a pad operation: blocks other buttons meanwhile and reports success or failure in the status bar. */
async function runOnPad(label, operation) {
  if (isBusy || !isConnected()) return;
  isBusy = true;
  document.body.classList.add("busy");
  setStatus(label + "…");
  try {
    const message = await operation(); // an operation can return its own success message
    setStatus(message || label + " — done", "ok");
  } catch (error) {
    console.error(error);
    setStatus(`${label} failed: ${error.message || error}`, "err");
  } finally {
    isBusy = false;
    document.body.classList.remove("busy");
  }
}

/** Enables the buttons that need a connected pad (and, for Write keys, valid bindings). */
function updateButtons() {
  const hasInvalidBinding = !state.profiles.every((bindings) => bindings.every(isValidBinding));
  document.querySelectorAll(".needs-device").forEach((button) => {
    button.disabled = !isConnected() || (button.id === "writeKeysBtn" && hasInvalidBinding);
  });
}

// ============ 3. tabs ============

function renderTabs() {
  document.querySelectorAll("#tabs button").forEach((button) => {
    button.classList.toggle("on", button.dataset.tab === state.activeTab);
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("on", panel.dataset.panel === state.activeTab);
  });
}

byId("tabs").onclick = (event) => {
  const tab = event.target.closest("button")?.dataset.tab;
  if (!tab) return;
  state.activeTab = tab;
  saveState();
  renderTabs();
};

// ============ 4. keys tab ============

// Browser KeyboardEvent.code -> our key names (letters, digits, F-keys and numpad are handled in keyNameFromCode).
const KEY_NAMES_BY_CODE = {
  Enter: "enter", Escape: "esc", Backspace: "backspace", Tab: "tab", Space: "space",
  Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Backquote: "`", Comma: ",", Period: ".", Slash: "/",
  CapsLock: "capslock", PrintScreen: "printscreen", ScrollLock: "scrolllock", Pause: "pause",
  Insert: "insert", Home: "home", PageUp: "pageup", Delete: "delete", End: "end", PageDown: "pagedown",
  ArrowRight: "right", ArrowLeft: "left", ArrowDown: "down", ArrowUp: "up", ContextMenu: "menu",
  ControlLeft: "ctrl", ShiftLeft: "shift", AltLeft: "alt", MetaLeft: "win",
  ControlRight: "rctrl", ShiftRight: "rshift", AltRight: "ralt", MetaRight: "rwin",
};

function keyNameFromCode(code) {
  return (
    KEY_NAMES_BY_CODE[code] ??
    code
      .replace(/^Key(.)$/, (_, letter) => letter.toLowerCase()) // KeyA -> a
      .replace(/^Digit(\d)$/, "$1") // Digit1 -> 1
      .replace(/^Numpad(\d)$/, "kp$1") // Numpad1 -> kp1
      .replace(/^F(\d+)$/, "f$1") // F5 -> f5
  );
}

const isModifier = (name) => Object.hasOwn(K815.MODIFIERS, name);
const isMedia = (binding) => Object.hasOwn(K815.MEDIA, binding);

function isValidBinding(binding) {
  if (!binding) return true; // unassigned is fine
  try {
    K815.parseBinding(binding);
    return true;
  } catch {
    return false;
  }
}

/** The big keycap graphics shown in the editor, e.g. [ctrl] + [c]  then  [ctrl] + [v]. */
function bindingPreviewHtml(binding) {
  if (!binding) return '<span class="none">unassigned</span>';
  if (isMedia(binding)) return `<kbd class="media">♪ ${binding}</kbd>`;
  return binding
    .split(" ")
    .map((combo) =>
      combo
        .split("+")
        .map((key) => `<kbd>${escapeHtml(key)}</kbd>`)
        .join("<i>+</i>"),
    )
    .join("<i>then</i>");
}

/** Updates the label printed on one keycap of the pad drawing. */
function renderKeycap(index) {
  const binding = currentBindings()[index];
  const keycap = byId("keycaps").children[index];
  const legend = keycap.querySelector(".legend");

  const emptyMark = currentUnrecognised().includes(index) ? "?" : "·";
  const text = binding ? binding.toUpperCase().split(" ").join("\n") : emptyMark;
  legend.textContent = text;
  legend.className = "legend";
  if (!binding) legend.classList.add("empty");
  else if (isMedia(binding)) legend.classList.add("media");
  if (text.length > 18) legend.classList.add("longer");
  else if (text.length > 8) legend.classList.add("long");

  keycap.classList.toggle("selected", index === state.selectedKey);
}

/** Redraws the editor for the selected key. Pass syncInput=false while the user is typing in the box. */
function renderKeyEditor(syncInput) {
  const index = state.selectedKey;
  const binding = currentBindings()[index];
  const valid = isValidBinding(binding);

  byId("keyLabel").textContent = "KEY " + (index + 1);
  const isCustomMacro = !binding && currentUnrecognised().includes(index);
  byId("keyPreview").innerHTML = !valid
    ? '<span class="none bad">not a valid combo</span>'
    : isCustomMacro
      ? '<span class="none">Custom macro on the pad. This page can\'t show it; type a binding to replace it.</span>'
      : bindingPreviewHtml(binding);
  byId("keyInput").classList.toggle("bad", !valid);
  if (syncInput) byId("keyInput").value = binding;

  document.querySelectorAll("#mediaChips .chip").forEach((chip) => {
    chip.classList.toggle("on", chip.dataset.media === binding);
  });
  currentBindings().forEach((_, i) => renderKeycap(i));
  updateButtons();
}

function setBinding(text, syncInput = true) {
  currentBindings()[state.selectedKey] = K815.normalizeSpec(text);
  if (text) unrecognised[state.selectedProfile] = currentUnrecognised().filter((key) => key !== state.selectedKey);
  saveState();
  renderKeyEditor(syncInput);
}

function selectKey(index) {
  state.selectedKey = index;
  saveState();
  renderKeyEditor(true);
}

/** Press the keys you want; Esc-style cancel is a click anywhere else. Modifiers alone also work. */
function startRecording() {
  const button = byId("recordBtn");
  const heldModifiers = [];
  button.textContent = "press keys…";
  button.classList.add("live");

  function stop(binding) {
    removeEventListener("keydown", onKeyDown, true);
    removeEventListener("keyup", onKeyUp, true);
    removeEventListener("pointerdown", onPointerDown, true);
    button.textContent = "● Record";
    button.classList.remove("live");
    if (binding) setBinding(binding);
  }

  function onKeyDown(event) {
    event.preventDefault();
    event.stopPropagation();
    const name = keyNameFromCode(event.code);
    if (isModifier(name)) {
      if (!heldModifiers.includes(name)) heldModifiers.push(name);
    } else if (Object.hasOwn(K815.KEYS, name)) {
      stop([...heldModifiers, name].join("+"));
    } else {
      setStatus(`No scancode for "${event.code}"`, "err");
    }
  }

  function onKeyUp(event) {
    // A modifier released with nothing else pressed means the binding is just that modifier.
    if (heldModifiers.length && isModifier(keyNameFromCode(event.code))) stop(heldModifiers.join("+"));
  }

  function onPointerDown(event) {
    if (event.target !== button) stop(null); // clicked elsewhere: cancel
  }

  addEventListener("keydown", onKeyDown, true);
  addEventListener("keyup", onKeyUp, true);
  addEventListener("pointerdown", onPointerDown, true);
}

function buildKeysTab() {
  byId("keycaps").innerHTML = currentBindings()
    .map((_, i) => `<button class="keycap"><span class="cap-number">${i + 1}</span><span class="legend"></span></button>`)
    .join("");

  [...byId("keycaps").children].forEach((keycap, index) => {
    keycap.onpointerdown = () => {
      keycap.classList.add("down");
      lastKeypress = 1; // makes the React preview flash
    };
    keycap.onpointerup = keycap.onpointerleave = () => keycap.classList.remove("down");
    keycap.onclick = () => selectKey(index);
  });

  byId("mediaChips").innerHTML = Object.keys(K815.MEDIA)
    .map((name) => `<button class="chip" data-media="${name}">${name}</button>`)
    .join("");
  byId("mediaChips").onclick = (event) => {
    const name = event.target.dataset.media;
    if (name) setBinding(name);
  };

  byId("keyInput").oninput = () => setBinding(byId("keyInput").value, false);
  byId("clearBtn").onclick = () => setBinding("");
  byId("recordBtn").onclick = startRecording;
  byId("writeKeysBtn").onclick = () => {
    // Warn about every profile whose unreadable macros this write would erase.
    const warnings = state.profiles
      .map((bindings, profile) => {
        const lost = unrecognised[profile].filter((key) => !bindings[key]).map((key) => key + 1);
        return lost.length ? `Profile ${profile + 1} key ${lost.join(", ")}` : null;
      })
      .filter(Boolean);
    if (warnings.length && !confirm(`${warnings.join("; ")} hold custom macros this page can't read. Writing will erase them. Continue?`)) return;
    runOnPad("Writing keys", async () => {
      await writeKeyBindings(state.profiles);
      unrecognised = unrecognised.map((keys, profile) => keys.filter((key) => state.profiles[profile][key]));
      renderKeyEditor(true);
    });
  };
}

/**
 * The profile strip above the key editor. Selecting a profile changes what the Keys tab edits and,
 * when the pad is connected, switches the pad to it too: that is cheap (two 8-byte blocks plus
 * apply, ~0.3s) because it writes byte 0x01 rather than the whole 4KB of bindings.
 */
function renderProfileTabs() {
  const live = isConnected() ? state.activeProfile : -1;
  byId("profileTabs").innerHTML = state.profiles
    .map((bindings, profile) => {
      const badge = profile === live ? '<em class="live">live</em>' : "";
      const selected = profile === state.selectedProfile ? "on" : "";
      const assigned = bindings.filter(Boolean).length;
      return (
        `<button data-profile="${profile}" class="${selected}">` +
        `<i>0${profile + 1}</i>Profile ${profile + 1}${badge}` +
        `<small>${assigned}/${K815.NUM_KEYS}</small></button>`
      );
    })
    .join("");
  byId("profileScopeLabel").textContent = `Profile ${state.selectedProfile + 1}`;
  byId("profileReadout").textContent = isConnected() ? `${state.activeProfile + 1} of 4 live` : "—";
}

byId("profileTabs").onclick = (event) => {
  const button = event.target.closest("[data-profile]");
  if (!button || isBusy) return;
  const profile = Number(button.dataset.profile);
  state.selectedProfile = profile;
  saveState();
  renderProfileTabs();
  renderKeyEditor(true);
  if (!isConnected()) return;
  runOnPad(`Switching to Profile ${profile + 1}`, async () => {
    await switchProfile(profile);
    state.activeProfile = profile;
    saveState();
    renderProfileTabs();
  });
};

// ============ 5. light tab ============

const LIGHT_MODES = [
  ["static", "Static", "solid colour"],
  ["breathe", "Breathe", "slow pulse"],
  ["cycle", "Cycle", "colours in turn"],
  ["fade", "Fade", "crossfade"],
  ["react", "React", "lights on keypress"],
  ["off", "Off", "dark"],
];
const REACT_STYLES = [
  [0, "Breath"],
  [1, "Water"],
  [2, "Comet"],
  [3, "Mono"],
];
const MULTI_COLOR_MODES = ["cycle", "fade", "react"]; // these can use up to MAX_COLORS colours
const ANIMATED_MODES = ["breathe", "cycle", "fade", "react"]; // these have a speed
const MAX_COLORS = 7;

function renderLightTab() {
  const mode = state.lightMode;
  byId("modeTiles").innerHTML = tileButtons(LIGHT_MODES, mode, "mode");
  byId("reactTiles").innerHTML = tileButtons(REACT_STYLES, state.reactStyle, "style");

  byId("colorField").classList.toggle("hidden", mode === "off");
  byId("brightField").classList.toggle("hidden", mode === "off");
  byId("speedField").classList.toggle("hidden", !ANIMATED_MODES.includes(mode));
  byId("reactField").classList.toggle("hidden", mode !== "react");
  byId("colorHint").textContent = MULTI_COLOR_MODES.includes(mode) ? `· up to ${MAX_COLORS}` : "";
  byId("speed").value = state.speed;
  byId("bright").value = state.brightness;
  byId("speedValue").textContent = state.speed;
  byId("brightValue").textContent = state.brightness;
  renderSwatches();
}

function renderSwatches() {
  const allowsMany = MULTI_COLOR_MODES.includes(state.lightMode);
  const canRemove = allowsMany && state.colors.length > 1;
  const canAdd = allowsMany && state.colors.length < MAX_COLORS;

  byId("swatches").innerHTML =
    state.colors
      .map((color, i) => {
        const removeButton = canRemove ? `<span class="swatch-remove" data-remove="${i}">×</span>` : "";
        return `<label class="swatch" style="background:${color}"><input type="color" value="${color}" data-index="${i}">${removeButton}</label>`;
      })
      .join("") + (canAdd ? '<button class="swatch-add" id="addColorBtn">+</button>' : "");

  byId("swatches").querySelectorAll("input").forEach((input) => {
    input.oninput = () => {
      state.colors[input.dataset.index] = input.value;
      input.parentElement.style.background = input.value;
      saveState();
    };
  });
  byId("swatches").querySelectorAll("[data-remove]").forEach((removeButton) => {
    removeButton.onclick = (event) => {
      event.preventDefault(); // don't open the colour picker underneath
      state.colors.splice(removeButton.dataset.remove, 1);
      saveState();
      renderSwatches();
    };
  });
  byId("addColorBtn")?.addEventListener("click", () => {
    const randomColor = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
    state.colors.push("#" + randomColor);
    saveState();
    renderSwatches();
  });
}

byId("modeTiles").onclick = (event) => {
  const mode = event.target.closest("[data-mode]")?.dataset.mode;
  if (!mode) return;
  state.lightMode = mode;
  if (!MULTI_COLOR_MODES.includes(mode)) state.colors.length = 1;
  saveState();
  renderLightTab();
};

byId("reactTiles").onclick = (event) => {
  const style = event.target.closest("[data-style]")?.dataset.style;
  if (style === undefined) return;
  state.reactStyle = Number(style);
  saveState();
  renderLightTab();
};

for (const name of ["speed", "bright"]) {
  const key = name === "bright" ? "brightness" : "speed";
  byId(name).value = state[key];
  byId(name).oninput = () => {
    state[key] = Number(byId(name).value);
    byId(name + "Value").textContent = state[key];
    saveState();
  };
}

byId("applyLightingBtn").onclick = () => {
  const off = state.lightMode === "off";
  runOnPad("Applying lighting", () =>
    writeLighting({
      mode: off ? "static" : state.lightMode, // "off" is a black static colour
      colors: off ? [[0, 0, 0]] : state.colors.map(hexToRgb),
      brightness: state.brightness,
      speed: state.speed,
      reactStyle: state.reactStyle,
    }),
  );
};

// ============ 6. device tab ============

function renderPollRate() {
  const tiles = Object.keys(K815.POLL_RATES).map((hz) => [hz, hz, "Hz"]);
  byId("pollTiles").innerHTML = tileButtons(tiles, state.pollRate, "hz");
  byId("pollReadout").textContent = state.pollRate ? state.pollRate + " Hz" : "—";
}

byId("pollTiles").onclick = (event) => {
  const hz = event.target.closest("[data-hz]")?.dataset.hz;
  if (!hz) return;
  runOnPad(`Setting ${hz} Hz`, async () => {
    state.pollRate = await writePollRate(Number(hz));
    saveState();
    renderPollRate();
  });
};

byId("readPadBtn").onclick = () => runOnPad("Reading from pad", loadFromPad);

byId("backupBtn").onclick = () =>
  runOnPad("Backup", async () => {
    const bytes = await readFullConfig((done, total) =>
      setStatus(`Reading config… ${Math.round((done / total) * 100)}%`),
    );
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
    Object.assign(document.createElement("a"), { href: url, download: "k815-config.bin" }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

// ============ 7. pad preview ============
// The seams between the keycaps glow in the colour the real LEDs would show.

let lastKeypress = 0; // 1 right after a keycap is pressed, then fades (drives the React preview)

const blend = (from, to, amount) => from.map((value, i) => value + (to[i] - value) * amount);

function drawPreview(timeMs) {
  const colors = state.colors.map(hexToRgb);
  const periodMs = 6500 - state.speed * 900; // speed 0 = slow = long period
  const cycles = timeMs / periodMs;
  const brightness = 0.3 + (0.7 * (state.brightness - 1)) / 6;

  let color = colors[0];
  let intensity = 1;
  switch (state.lightMode) {
    case "off":
      intensity = 0;
      break;
    case "breathe":
      intensity = 0.12 + 0.88 * (0.5 - 0.5 * Math.cos(cycles * 2 * Math.PI));
      break;
    case "cycle": // each colour breathes in and out in turn
      color = colors[Math.floor(cycles) % colors.length];
      intensity = Math.sin(Math.PI * (cycles % 1)) ** 1.5;
      break;
    case "fade": // crossfade to the next colour
      color = blend(colors[Math.floor(cycles) % colors.length], colors[(Math.floor(cycles) + 1) % colors.length], cycles % 1);
      break;
    case "react": // dim until a key is pressed
      lastKeypress *= 0.94;
      intensity = 0.1 + 0.9 * lastKeypress;
      break;
  }

  const [r, g, b] = color.map((channel) => Math.round(channel * intensity * brightness));
  byId("padBody").style.setProperty("--glow", `rgb(${r},${g},${b})`);
  requestAnimationFrame(drawPreview);
}

// ============ 8. connection ============

function showConnected(connected) {
  byId("connStatus").textContent = connected ? "Connected" : "Disconnected";
  byId("connStatus").classList.toggle("on", connected);
  byId("connectBtn").textContent = connected ? "Reconnect" : "Connect";
  updateButtons();
}

/** Reads the pad's saved keys, lighting and polling rate into the page. Returns a status message. */
async function loadFromPad() {
  const config = await readPadConfig();

  state.profiles = config.profiles.map((profile) => profile.bindings);
  unrecognised = config.profiles.map((profile) => profile.unrecognised);
  state.activeProfile = config.activeProfile;
  state.selectedProfile = config.activeProfile; // show the profile the pad is actually using
  state.pollRate = config.pollRate;
  if (config.lighting) {
    const { mode, ...rest } = config.lighting; // colors, speed, brightness, reactStyle share names with state
    Object.assign(state, rest, { lightMode: mode });
  }
  saveState();

  renderKeyEditor(true);
  renderLightTab();
  renderPollRate();
  renderProfileTabs();

  const notes = [`Profile ${config.activeProfile + 1} is live`];
  const customKeys = config.profiles[config.activeProfile].unrecognised;
  if (customKeys.length) notes.push(`key ${customKeys.map((key) => key + 1).join(", ")} hold macros this page can't show`);
  if (!config.lighting) notes.push("lighting mode not supported here, left unchanged");
  return "Read from pad: " + notes.join("; ");
}

async function connectTo(hidDevice) {
  await openDevice(hidDevice);
  showConnected(true);
  await runOnPad("Reading from pad", loadFromPad);
}

function setUpConnection() {
  if (!navigator.hid) {
    byId("noHidWarning").style.display = "block";
    return;
  }

  byId("connectBtn").onclick = async () => {
    try {
      const [chosen] = await navigator.hid.requestDevice({
        filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID, usagePage: VENDOR_USAGE_PAGE }],
      });
      if (!chosen) return; // picker cancelled
      await closeDevice();
      await connectTo(chosen);
    } catch (error) {
      setStatus("Connect failed: " + error.message, "err");
    }
  };

  // Reconnect automatically to a pad this site already has permission for.
  navigator.hid.getDevices().then((devices) => {
    const known = devices.find(isK815);
    if (known) connectTo(known).catch((error) => setStatus(error.message, "err"));
  });

  navigator.hid.onconnect = (event) => {
    if (isK815(event.device) && !isConnected()) connectTo(event.device).catch(() => {});
  };
  navigator.hid.ondisconnect = (event) => {
    if (!isCurrentDevice(event.device)) return;
    closeDevice();
    showConnected(false);
    setStatus("Pad disconnected.", "err");
  };
}

// ============ 9. start-up ============

buildKeysTab();
renderTabs();
renderProfileTabs();
renderLightTab();
renderPollRate();
renderKeyEditor(true);
setUpConnection();
updateButtons();
requestAnimationFrame(drawPreview);
