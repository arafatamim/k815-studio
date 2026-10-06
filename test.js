// node test.js: checks the byte output of k815-codec.js
const fs = require('fs'), assert = require('assert');
const K = new Function(fs.readFileSync(__dirname + '/k815-codec.js', 'utf8') + ';return K815')();
const eq = (a, b) => assert.deepStrictEqual([...a], [...b]);

assert.deepStrictEqual(K.parseBinding('kp1'), ['macro', [[true, 0x59], [false, 0x59]]]);
const {types, entries, area} = K.buildBindings({0: 'ctrl+shift+a', 1: 'volup', 2: 'x'});
assert.deepStrictEqual({...types}, {0: 0x0D, 1: 0x0F, 2: 0x0D});
eq(area.slice(0, 16), [1, 0, 0x94, 0xE0, 0x94, 0xE1, 0x94, 0x04, 0x14, 0x04, 0x14, 0xE1, 0x14, 0xE0, 0, 0]);
eq(entries[0], [0, 6, 0, 0, 0, 0x00, 0x04, 0, 0, 0]);
eq(entries[1], [0, 0, 0, 0xE9, 0, 0x10, 0x04, 0, 0, 0]);
eq(area.slice(16, 24), [1, 0, 0x94, 0x1B, 0x14, 0x1B, 0, 0]);
assert.throws(() => K.parseBinding('ctrl+nope'));

// LED: write orange into a blank config, then decode it back
const d = Array(0x100).fill(0); // a blank config is enough to check the encoding
const led = K.buildLedSettings(d.slice(8, 0x70), 'static', [[255, 170, 0]], 0, 3, 0);
const channel = (settings, slot, c, user) => { const [a, sh] = K.colorNibbleAddr(3 * slot + c, user); return settings[a - 8] >> sh & 15; };
for (let slot = 0; slot < 7; slot++) eq([0, 1, 2].map(c => channel(led.settings, slot, c, true)), [0, 5, 15]);
for (let slot = 0; slot < 6; slot++) eq([0, 1, 2].map(c => channel(led.settings, slot, c, false)), [0, 5, 15]);
assert.strictEqual(led.settings[0x1C - 8], 2 << 4 | 3); assert.strictEqual(led.firmwareMode, 2); assert.strictEqual(led.reactFlag, 0);
// react sets button-response bits on every key type byte
const r = K.buildLedSettings(d.slice(8, 0x70), 'react', [[255, 0, 0]], 0, 3, 1);
for (const p of K.TYPE_ADDR) for (const a of p) assert.strictEqual(r.settings[a - 8] & 0xE0, 0x20 | 1 << 6);
// full key image keeps the identity header and sizes the table
const img = K.buildKeyImage(d.slice(0, 0xA0), {0: 'a'});
eq(img.header.slice(0, 8), d.slice(0, 8)); assert.strictEqual(img.table.length, 0x230);
// live LED report matches the Python tool: [0x13, 0xFF, 0x80+(mode<<4)+speed, 0x0F, dim, 0x03, 0xFF]
eq(K.ledLiveReport(2, 3, 0, 0), [0x13, 0xFF, 0xA3, 0x0F, 0, 0x03, 0xFF]);

// reading back: encode a layout, then decode what the pad would hold
const specs = ['ctrl+shift+a', 'ctrl+c ctrl+v', 'volup', 'x', 'f13', '', 'kp5', 'playpause'];
const bound = {}; specs.forEach((s, k) => { if (s) bound[k] = s; });
const image = K.buildKeyImage(Array(0xA0).fill(0), bound);
const macros = image.area;
const back = K.decodeBindings(image.header, image.table.slice(0, 80), macros);
eq(back.bindings, specs); eq(back.unrecognised, []);
// a macro other software might write (interleaved presses) is reported, not mangled
const odd = [...image.area]; odd[2] = 0x94; odd[3] = 0xE0; odd[4] = 0x94; odd[5] = 0x04; odd[6] = 0x14; odd[7] = 0xE0; odd[8] = 0x14; odd[9] = 0x04;
const bad = K.decodeBindings(image.header, image.table.slice(0, 80), odd);
assert.ok(bad.unrecognised.includes(0)); assert.strictEqual(bad.bindings[0], '');
// lighting round trip (colours that survive 4-bit rounding)
const full = Array(0xA0).fill(0);
for (const [mode, colors, expectColors, extra] of [
  ['static', [[255, 85, 17]], ['#ff5511'], {}], ['fade', [[255, 0, 0], [0, 0, 255]], ['#ff0000', '#0000ff'], {}],
  ['breathe', [[0, 0, 255], [255, 0, 0]], ['#0000ff'], {}], ['react', [[255, 0, 0]], ['#ff0000'], {style: 2}]]) {
  const h = [...full]; const l = K.buildLedSettings(h.slice(8, 0x70), mode, colors, 2, 4, extra.style ?? 0);
  h.splice(8, 0x68, ...l.settings);
  assert.deepStrictEqual(K.decodeLighting(h), {mode, colors: expectColors, speed: 4, brightness: 5, reactStyle: extra.style ?? 0}, mode);
}
const dark = [...full]; dark.splice(8, 0x68, ...K.buildLedSettings(dark.slice(8, 0x70), 'static', [[0, 0, 0]], 0, 3, 0).settings);
assert.strictEqual(K.decodeLighting(dark).mode, 'off');
const unknown = [...full]; unknown[0x1C] = 4 << 4; assert.strictEqual(K.decodeLighting(unknown), null);
const poll = [...full]; poll[0x1E] = 1; assert.strictEqual(K.decodePollRate(poll), 500);

// ---- profiles ----
// Byte 0x01 selects the active profile as 0x03 | (profile << 5); the vendor tool mirrors the plain
// index into 0x76. Confirmed on hardware: writing byte 0x01 switches the pad, 0x76 alone does not.
assert.strictEqual(K.NUM_PROFILES, 4);
eq([0, 1, 2, 3].map(K.profileSelectorByte), [0x03, 0x23, 0x43, 0x63]);
eq([0x03, 0x23, 0x43, 0x63, 0xFF].map(K.profileFromSelectorByte), [0, 1, 2, 3, 3]);
assert.strictEqual(K.PROFILE_SELECTOR_ADDR, 1);
assert.strictEqual(K.PROFILE_MIRROR_ADDR, 0x76);
// switching changes byte 1 only: bytes 0 and 2-7 are the identity header and are passed through
const ident = [0x5A, 0x03, 0xA5, 0x40, 0x13, 0xFA, 0x30, 0x10];
eq(K.buildProfileSelectBlock(ident, 3), [0x5A, 0x63, 0xA5, 0x40, 0x13, 0xFA, 0x30, 0x10]);
eq(K.buildProfileSelectBlock(ident, 0), ident);

// four different layouts: each profile gets its own type bytes, table block and macro record
const four = K.buildProfileImage(Array(0xA0).fill(0), [{ 0: 'a' }, { 0: 'i' }, { 0: 'q' }, { 0: 'y' }]);
assert.strictEqual(four.table.length, 0x230);
assert.strictEqual(four.area.length, 32);
K.TYPE_ADDR.forEach((addrs, p) => {
  assert.strictEqual(four.header[addrs[0]] & 0x1F, 0x0D, `profile ${p} key 1 is a macro`);
  assert.strictEqual(four.header[addrs[1]] & 0x1F, 0, `profile ${p} key 2 is unassigned`);
});
const pEntry = (image, profile, key) => image.table.slice(profile * 0x8C + key * 10, profile * 0x8C + key * 10 + 10);
[0, 1, 2, 3].forEach((p) => eq(pEntry(four, p, 0).slice(5, 7), [p * 8, 0x04]));
eq(four.area.slice(0, 8), [1, 0, 0x94, 0x04, 0x14, 0x04, 0, 0]);
eq(four.area.slice(8, 16), [1, 0, 0x94, 0x0C, 0x14, 0x0C, 0, 0]);
eq([four.header[0x6E], four.header[0x6F]], [0x20, 0x04]); // macro end = 0x420
// identities are untouched, including the active profile byte
const withActive = Array(0xA0).fill(0);
withActive[K.PROFILE_SELECTOR_ADDR] = 0x43;
assert.strictEqual(K.buildProfileImage(withActive, [{ 0: 'a' }, {}, {}, {}]).header[K.PROFILE_SELECTOR_ADDR], 0x43);
// identical layouts share one set of records; empty profiles leave their keys unassigned
const same = K.buildProfileImage(Array(0xA0).fill(0), ['a', 'a', 'a', 'a'].map((spec) => ({ 0: spec })));
assert.strictEqual(same.area.length, 8);
assert.strictEqual(pEntry(same, 0, 0).join(), pEntry(same, 3, 0).join());
const blank = K.buildProfileImage(Array(0xA0).fill(0), [{}, {}, {}, {}]);
assert.strictEqual(blank.area.length, 0);

// decoding is per profile: profile 2's entries must be read with profile 2's type bytes
const d2 = K.decodeBindings(four.header, four.table.slice(2 * 0x8C, 2 * 0x8C + 80), four.area, 2);
eq(d2.bindings.slice(0, 1), ['q']);
eq(d2.unrecognised, []);
eq(K.decodeBindings(four.header, four.table.slice(0, 80), four.area).bindings.slice(0, 1), ['a']);
console.log('ok');
