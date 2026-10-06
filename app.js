/*
 * K815 Studio UI. Talks to the pad through the functions in k815-device.js
 * and encodes through K815 (k815-codec.js). Sections:
 *   1. state          4. keys tab        7. pad preview
 *   2. small helpers  5. light tab       8. connection
 *   3. tabs           6. device tab      9. start-up
 */

// ============ 1. state ============

const DEFAULT_STATE = {
  keyBindings: Array(K815.NUM_KEYS).fill(""), // "" = unassigned
  selectedKey: 0,
  activeTab: "keys",
  lightMode: "static",
  colors: ["#ff4f12"],
  speed: 3, // 0 slow .. 6 fast
  brightness: 7, // 1 dim .. 7 bright
  reactStyle: 0,
  pollRate: 0, // Hz as last read from the pad, 0 = unknown
};

// Saved in this browser so your layout is still here next visit. Never leaves the machine.
const STORAGE_KEY = "k815";
let state = { ...DEFAULT_STATE };
try {
  state = { ...DEFAULT_STATE, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
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

// ============ 2. small helpers ============

const byId = (id) => document.getElementById(id);

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
    await operation();
    setStatus(label + " — done", "ok");
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
  const hasInvalidBinding = !state.keyBindings.every(isValidBinding);
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
  const binding = state.keyBindings[index];
  const keycap = byId("keycaps").children[index];
  const legend = keycap.querySelector(".legend");

  const text = binding ? binding.toUpperCase().split(" ").join("\n") : "·";
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
  const binding = state.keyBindings[index];
  const valid = isValidBinding(binding);

  byId("keyLabel").textContent = "KEY " + (index + 1);
  byId("keyPreview").innerHTML = valid
    ? bindingPreviewHtml(binding)
    : '<span class="none bad">not a valid combo</span>';
  byId("keyInput").classList.toggle("bad", !valid);
  if (syncInput) byId("keyInput").value = binding;

  document.querySelectorAll("#mediaChips .chip").forEach((chip) => {
    chip.classList.toggle("on", chip.dataset.media === binding);
  });
  state.keyBindings.forEach((_, i) => renderKeycap(i));
  updateButtons();
}

function setBinding(text, syncInput = true) {
  state.keyBindings[state.selectedKey] = K815.normalizeSpec(text);
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
  byId("keycaps").innerHTML = state.keyBindings
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
    const bindings = {};
    state.keyBindings.forEach((binding, index) => {
      if (binding) bindings[index] = binding;
    });
    runOnPad("Writing keys", () => writeKeyBindings(bindings));
  };
}

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

async function connectTo(hidDevice) {
  await openDevice(hidDevice);
  showConnected(true);
  runOnPad("Reading poll rate", async () => {
    state.pollRate = await readPollRate();
    saveState();
    renderPollRate();
  });
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
renderLightTab();
renderPollRate();
renderKeyEditor(true);
setUpConnection();
updateButtons();
requestAnimationFrame(drawPreview);
