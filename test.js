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
console.log('ok');
