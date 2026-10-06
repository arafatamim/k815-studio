# K815 protocol notes

Reverse-engineered from the vendor's Windows tool (`Gaming Mouse 3.0.exe`, a C++/MFC program) by static analysis (disassembly and Ghidra decompilation), then confirmed on a real pad. Nothing here comes from vendor documentation.

**Confidence.** Items marked *(hw)* were confirmed on hardware. Items marked *(re)* come from reading the vendor tool and have not been exercised.

## Device

| | |
|---|---|
| USB ID | `30FA:1340`, product string "INSTANT USB GAMING MOUSE" |
| Firmware | a generic gaming-mouse firmware reused as an 8-key macropad |
| Config channel | HID **feature reports**, report ID `7`, 8 bytes (ID plus 7 data bytes) |
| Collection | the vendor-defined one, usage page `0xFF01` |

The pad also has normal keyboard and mouse interfaces. Only the `0xFF01` collection is used for configuration, which is why WebHID can reach it (browsers block the keyboard and mouse collections).

## Transport quirks

- Send with `HidD_SetFeature` / WebHID `sendFeatureReport(7, bytes)`. In WebHID the report ID is passed separately, so `bytes` is the 7 data bytes after the ID.
- Read with `HidD_GetFeature` / `receiveFeatureReport(7)`. On Windows Chromium the returned data still has the report ID as byte 0, so the value is in byte 1 *(hw)*. Handle both layouts.
- The pad's internal buffer wraps at 64 bytes. **Read and write at most 8 bytes at a time**, like the vendor tool. A larger read returns wrapped data, and writing that back corrupts the config *(hw, learned the hard way)*.

## Config command `0x18`

All memory access uses one command. Packet (after the report ID):

```
18 <flags> <i> <addrLo> <addrHi> <data> <len-1>
```

| flags | meaning |
|---|---|
| `0x03` | stage byte number `i` of the block, with value `data` |
| `0x09` | commit the staged bytes to `addr` |
| `0x05` | read byte `i` of the block; the value comes back in the feature report |
| `0x10` | apply (make the pad use the new config) |
| `0x00` | end of command |

`len-1` is the block length minus one (0..7). `addr` is little-endian.

### Read an 8-byte block *(hw)*

1. For `i` in `0..len-1`: send `03, i, addr, data=0, len-1`, wait 2 ms. (This zero-staging step is what the vendor tool does first.)
2. Wait 2 ms, send `00` with `addr`.
3. For `i` in `0..len-1`: send `05, i, addr, 0, len-1`, wait 2 ms, then get the feature report. The byte is the value.
4. Wait 2 ms, send `00`.

### Write a block of up to 8 bytes *(hw)*

1. For each byte: send `03, i, addr, data[i], len-1`.
2. Wait 4 ms, send `09, 0, addr, 0, len-1`.
3. Wait 2 ms, send `00` with `addr`.

After one or more writes, send **apply**: `10`, wait 5 ms, then `00`. Skipping unchanged blocks keeps writes fast and reduces flash wear.

## Config memory (4 KB)

Only the regions below are used by this app.

| Address | Content |
|---|---|
| `0x00-0x07` | identity header, plus the active profile in byte `0x01` (see below). Write it only as a whole block read off the pad with byte 1 changed: bytes 0 and 2-7 must survive verbatim. |
| `0x08-0x6F` | settings (below) |
| `0x6E-0x7A` | pointers to the end of the macro area |
| `0xA0-0x2CF` | key table: 4 profiles × `0x8C` bytes, 10-byte entry per key slot |
| `0x400-0xF1F` | macro area |

### Active profile *(hw)*

One byte of the identity header says which of the four profiles the pad is using:

| byte `0x01` | profile | vendor's name |
|---|---|---|
| `0x03` | 1 | Office |
| `0x23` | 2 | Game I |
| `0x43` | 3 | Game II |
| `0x63` | 4 | Game III |

So the byte is `0x03 | (profile << 5)` counting from zero, and byte `0x76` mirrors the plain index
(`0`-`3`).

**Switching** means: read the 8-byte block at `0x00`, set byte 1, write the block back with bytes 0
and 2-7 unchanged, write the mirrored index to `0x76`, then apply. That is two 8-byte blocks, about
**0.3 s** — versus roughly 10 s for a full key write, since a write costs ~100 ms per 8-byte block.

- Writing `0x76` on its own does nothing: `0x01` is the selector, `0x76` is bookkeeping.
- The pad keeps its active profile across a power cycle, and nothing on the device switches it — the
  vendor tool's profile buttons are the only built-in way to change it.
- Each profile has its own key type bytes and its own `0x8C`-byte block in the key table, but all four
  **share one macro area**, so writing any profile means rebuilding that area for all of them.
- The vendor tool's profile buttons move exactly these two bytes and nothing else.
- Confirmed by sweeping both bytes with a different binding in each profile (key 1 typing `a`, `i`,
  `q`, `y`): the pad emitted exactly the letter belonging to the selected profile, every step.

### Key type bytes

Each key has one type byte per profile, at

```
profile 0: 0x08 + k      profile 1: 0x44 + k      profile 2: 0x50 + k      profile 3: 0x60 + k      (k = 0..7)
```

| bits | meaning |
|---|---|
| 0-4 | `0x0D` on-device macro (also used for ordinary keys), `0x0F` media key, `0` none |
| 5 | "button response" lighting enabled for this key |
| 6-7 | button-response style (0 breathing, 1 water, 2 comet, 3 mono water) |

When rewriting key bindings, keep bits 5-7 and replace only bits 0-4, so the lighting setting survives *(hw)*.

Key order is reading order: key 1 is top-left *(hw)*.

### Key table entry

10 bytes at `0xA0 + profile*0x8C + k*10`, for `profile` 0-3 (so reading a profile means reading its own
`0x8C`-byte block and decoding it with that profile's type bytes):

```
[0, count & 0x7F, 0, usageLo, usageHi, macroAddrLo, macroAddr>>8 & 0x3F, count>>7 & 0x3F, 0, 0]
```

- Macro key: `count` is the number of key events; `usage` is 0; `macroAddr` points at the macro record.
- Media key: `count` is 0; `usage` is the HID consumer usage; `macroAddr` still holds the current macro-area address.

### Macro area

Starts at `0x400`. One record per macro key, padded to a multiple of 8 bytes:

```
01 00                          repeat once
(delayByte, hidCode) × count   one pair per key event
```

`delayByte` is the delay in ms before the event (the vendor tool's default is 20), with bit 7 set for key-down. `hidCode` is a USB HID keyboard usage (modifiers `0xE0-0xE7`). A combo such as `ctrl+c` becomes down(ctrl), down(c), up(c), up(ctrl). The area must stay below `0xF20`.

After the last macro, set the end pointers *(hw)*:

| Address | Value |
|---|---|
| `0x6E` (2 bytes) | `end` = `0x400 + macro bytes` |
| `0x70`, `0x72`, `0x74` (2 bytes each) | `end+8`, `end+16`, `end+24` |
| `0x78` | `00`, `(end+32) lo`, `(end+32) hi & 0x3F` |

The vendor tool lays four empty per-profile tables out right after the macros, which is what these point at.

### Polling rate *(hw)*

Byte `0x1E` is the interval in ms minus 1:

| Hz | 125 | 250 | 500 | 1000 |
|---|---|---|---|---|
| byte | 7 | 3 | 1 | 0 |

### Lighting settings

| Address | Content |
|---|---|
| `0x1C` | `mode << 4 \| reactFlag << 3 \| speed` |
| `0x3B` bit 7 | bit 3 of the mode (unused by the modes below) |
| `0x3F` bits 4-6 | brightness as dimming: 0 brightest ... 6 faintest |
| `0x20-0x2F`, `0x38`, `0x39`, `0x3E`, `0x3F` | colours (below) |

Modes that render distinctly on this pad *(hw for static; the rest (re))*:

| mode | name |
|---|---|
| 0 | breathing, one colour |
| 1 | cycle breathing through the colours |
| 2 | static |
| 6 | crossfade through the colours |
| 1 + reactFlag | "button response": lights on key press |

Other firmware modes exist but looked static on the test unit. Speed `0` is slowest; `7` switches the effect off.

**Colours.** The pad stores 7 user colours and 6 "DPI" colours. Each channel is 4 bits and **inverted**: `nibble = (255 - value) >> 4`. Channel number `c = 3*slot + (0 red, 1 green, 2 blue)`:

- channels 0-15 are at `0x20 + c`, channels 16-17 at `0x38 + (c-16)`
- DPI colours use the low nibble, user colours the high nibble
- the last user colour (slot 6, channels 18-20) is packed into the high and low nibbles of `0x3E` and the low nibble of `0x3F`

This app fills all 13 slots so every mode agrees. All 8 LEDs show the same colour; there is no per-key colour.

### Live commands (not saved)

Command `0x13` applies the LED mode immediately *(hw)*:

```
13  0x80|colourMask  (0x80 + (mode<<4) + reactFlag*8 + speed) & 0xFF  0F  dim  (mode>>3 & 1)<<7 | 03  FF
```

`colourMask` is `0x7F` for all seven user colour slots. Send it after writing and applying settings so the pad updates without replugging.

Command `0x14` sets a single DPI colour live, with no flash write: `14 (slot<<5 | G) (R<<4 | B)`. On the test pad it was only visible in mode 0 (breathing) *(hw)*, so it cannot be used as a steady "direct" colour mode.

## Vendor tool behaviour

On startup the vendor tool re-uploads its whole config, wiping any key mapping, polling rate and lighting set by other tools. Close it before using this app.

## Observations from the test unit

- All 8 LEDs share one colour, and the firmware's spatial effects render as static.
- On the unit used for reverse engineering, the **green channel produced no light** (red and blue worked). It is unknown whether this is common to the model or a fault on that unit. Yellow, green, cyan and white are therefore unavailable there.
