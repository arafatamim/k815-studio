/*
 * K815 device: talks to the pad over WebHID and exposes a few high-level actions.
 * No DOM here; the UI (app.js) calls these functions and shows the results.
 *
 * All traffic is 8-byte HID feature reports with report ID 7 on the vendor collection (usage page 0xFF01):
 *
 *   07 18 <flags> <i> <addrLo> <addrHi> <data> <len-1>
 *
 *   flags 0x03  stage byte number i of the block
 *   flags 0x09  commit the staged bytes to addr
 *   flags 0x05  read byte i of the block (the value comes back in the feature report)
 *   flags 0x10  apply
 *   flags 0x00  end of command
 */

const VENDOR_ID = 0x30fa;
const PRODUCT_ID = 0x1340;
const VENDOR_USAGE_PAGE = 0xff01;
const REPORT_ID = 7;
const CONFIG_CMD = 0x18;
const BLOCK_SIZE = 8; // the pad's buffer wraps at 64 bytes, so the vendor tool only moves 8 at a time

const FLAG_END = 0x00;
const FLAG_STAGE = 0x03;
const FLAG_READ = 0x05;
const FLAG_COMMIT = 0x09;
const FLAG_APPLY = 0x10;

let device = null; // the open HIDDevice, or null when disconnected

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isK815 = (hidDevice) =>
  hidDevice.vendorId === VENDOR_ID &&
  hidDevice.productId === PRODUCT_ID &&
  hidDevice.collections.some((c) => c.usagePage === VENDOR_USAGE_PAGE);

const sendReport = (bytes) => device.sendFeatureReport(REPORT_ID, new Uint8Array(bytes));

const sendConfigCommand = (flags = FLAG_END, index = 0, addr = 0, data = 0, length = 0) =>
  sendReport([CONFIG_CMD, flags, index, addr & 0xff, addr >> 8, data, length]);

// ---------- raw memory access ----------

/** Reads `length` bytes from the pad's config memory. Calls onProgress(done, total) between blocks. */
async function readBytes(addr, length, onProgress) {
  if (length > BLOCK_SIZE) {
    const bytes = [];
    for (let offset = 0; offset < length; offset += BLOCK_SIZE) {
      const blockLength = Math.min(BLOCK_SIZE, length - offset);
      bytes.push(...(await readBytes(addr + offset, blockLength)));
      onProgress?.(offset, length);
    }
    return bytes;
  }

  // Same sequence as the vendor tool, including its zero-staging step before the read.
  for (let i = 0; i < length; i++) {
    await sendConfigCommand(FLAG_STAGE, i, addr, 0, length - 1);
    await sleep(2);
  }
  await sleep(2);
  await sendConfigCommand(FLAG_END, 0, addr);

  const bytes = [];
  for (let i = 0; i < length; i++) {
    await sendConfigCommand(FLAG_READ, i, addr, 0, length - 1);
    await sleep(2);
    const report = await device.receiveFeatureReport(REPORT_ID);
    // Chromium on Windows leaves the report ID in byte 0, so the value is in byte 1.
    bytes.push(report.getUint8(report.byteLength > 7 ? 1 : 0));
  }
  await sleep(2);
  await sendConfigCommand();
  return bytes;
}

/** Writes up to 8 bytes at addr. Not saved permanently until applyChanges(). */
async function writeBlock(addr, bytes) {
  const lastIndex = bytes.length - 1;
  for (let i = 0; i < bytes.length; i++) await sendConfigCommand(FLAG_STAGE, i, addr, bytes[i], lastIndex);
  await sleep(4);
  await sendConfigCommand(FLAG_COMMIT, 0, addr, 0, lastIndex);
  await sleep(2);
  await sendConfigCommand(FLAG_END, 0, addr);
}

async function applyChanges() {
  await sendConfigCommand(FLAG_APPLY);
  await sleep(5);
  await sendConfigCommand();
}

/** Writes `newBytes` at addr, 8 bytes at a time, skipping blocks that equal `oldBytes` (if given). */
async function writeChangedBlocks(addr, newBytes, oldBytes) {
  for (let offset = 0; offset < newBytes.length; offset += BLOCK_SIZE) {
    const block = newBytes.slice(offset, offset + BLOCK_SIZE);
    const unchanged = oldBytes && block.every((byte, i) => byte === oldBytes[offset + i]);
    if (!unchanged) await writeBlock(addr + offset, block);
  }
}

// ---------- high-level actions ----------

/** bindings: {keyIndex: spec}. Rewrites all key bindings (same for all 4 profiles). */
async function writeKeyBindings(bindings) {
  const oldHeader = await readBytes(0, K815.HEADER_LEN);
  const { header, table, area } = K815.buildKeyImage(oldHeader, bindings);
  // Skip bytes 0x00-0x07: that's the identity header and must never be touched.
  await writeChangedBlocks(8, header.slice(8), oldHeader.slice(8));
  await writeChangedBlocks(K815.HEADER_LEN, table);
  await writeChangedBlocks(K815.MACRO_START, area);
  await applyChanges();
}

/** light: {mode, colors: [[r,g,b]], brightness: 1-7, speed: 0-6, reactStyle: 0-3}. Saved on the pad, then shown now. */
async function writeLighting({ mode, colors, brightness, speed, reactStyle }) {
  const dim = 7 - brightness;
  const old = await readBytes(K815.SETTINGS_BASE, 0x68);
  const { settings, firmwareMode, reactFlag } = K815.buildLedSettings(old, mode, colors, dim, speed, reactStyle);
  await writeChangedBlocks(K815.SETTINGS_BASE, settings, old);
  await applyChanges();
  await sendReport(K815.ledLiveReport(firmwareMode, speed, dim, reactFlag));
}

const POLL_BLOCK_ADDR = 0x18; // the poll byte sits in this aligned 8-byte block

/** Returns the polling rate in Hz, or 0 if the stored byte isn't one we know. */
async function readPollRate() {
  const block = await readBytes(POLL_BLOCK_ADDR, BLOCK_SIZE);
  const stored = block[K815.POLL_ADDR - POLL_BLOCK_ADDR];
  const hz = Object.keys(K815.POLL_RATES).find((rate) => K815.POLL_RATES[rate] === stored);
  return hz ? Number(hz) : 0;
}

async function writePollRate(hz) {
  const block = await readBytes(POLL_BLOCK_ADDR, BLOCK_SIZE);
  block[K815.POLL_ADDR - POLL_BLOCK_ADDR] = K815.POLL_RATES[hz];
  await writeBlock(POLL_BLOCK_ADDR, block);
  await applyChanges();
  return readPollRate();
}

/** The pad's whole 4 KB config memory, for backup. */
const readFullConfig = (onProgress) => readBytes(0, 0x1000, onProgress);

// ---------- connection ----------

async function openDevice(hidDevice) {
  if (!hidDevice.opened) await hidDevice.open();
  device = hidDevice;
}

async function closeDevice() {
  if (device?.opened) await device.close();
  device = null;
}

const isConnected = () => device !== null;
const isCurrentDevice = (hidDevice) => hidDevice === device;
