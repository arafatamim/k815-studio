# K815 Studio

A browser-based replacement for the vendor software of the **K815 8-key macropad** (USB `30FA:1340`, reports itself as "INSTANT USB GAMING MOUSE"). It remaps keys, sets lighting and changes the USB polling rate straight from Chrome or Edge, using [WebHID](https://developer.mozilla.org/en-US/docs/Web/API/WebHID_API). There is nothing to install and nothing leaves your machine.

The device protocol was reverse-engineered from the vendor's Windows tool. It is written up in [docs/PROTOCOL.md](docs/PROTOCOL.md).

> **Unofficial.** This is not affiliated with the pad's maker. It writes to the pad's flash memory. Download a backup first (Device tab), and use it at your own risk.

<img width="447" height="447" alt="image" src="https://github.com/user-attachments/assets/fa85541d-5c44-4874-853a-c652b8cb84ff" />

## Features

- **Keys:** bind each of the 8 keys to a shortcut (`ctrl+shift+a`), a sequence (`ctrl+c ctrl+v`) or a media key (volume, play/pause, ...). You can type the combo or press Record and hit the keys. The layout is written to all 4 on-device profiles.
- **Lighting:** static, breathe, cycle, fade, react-to-keypress and off, with colour, speed and brightness. A live preview shows how the pad should look. Settings are stored on the pad.
- **Device:** USB polling rate (125 / 250 / 500 / 1000 Hz) and a raw 4 KB config backup.

Settings are stored on the pad, so they keep working without this page or any software running.

## Running it

WebHID needs Chrome, Edge or another Chromium browser, and a secure context (`https://` or `http://localhost`).

```sh
python -m http.server 8000     # or any static file server
# open http://localhost:8000 and click Connect
```

It is plain HTML, CSS and JavaScript with no build step, so it can also be hosted on any static host with HTTPS.

**Close any other software for the pad first.** The vendor tool re-uploads its own config when it starts and will overwrite your keys, lighting and polling rate.

## What is tested

Tested on real hardware: single-key bindings, the polling rate, and static colours.
Written to the pad but not yet checked by eye or by key presses: react mode, and modifier combos, sequences and media keys.
Not yet tried: breathe, cycle and fade modes in this web app.

Please open an issue with your results.

## Limits

- All 8 keys share one backlight colour. The firmware has no per-key lighting.
- Only Chromium browsers support WebHID.
- Only the K815 (`30FA:1340`) is supported. Other pads from the same vendor may speak the same protocol, but that is unverified.

## Project layout

| File | Purpose |
|---|---|
| `index.html`, `style.css` | The page. |
| `app.js` | UI logic: key editor, lighting controls, live preview, connection handling. |
| `k815-device.js` | WebHID transport and the high-level actions (write keys, write lighting, poll rate, backup). |
| `k815-codec.js` | Pure functions that turn bindings and lighting settings into the bytes stored on the pad. |
| `test.js` | `node test.js` checks the codec's byte output. |
| `docs/PROTOCOL.md` | The reverse-engineered protocol and memory map. |

The three scripts load in order (codec, device, app) as classic scripts, with no modules or bundler.

## Development

```sh
node test.js     # codec checks, no hardware needed
```

If you change what gets written to the pad, read [docs/PROTOCOL.md](docs/PROTOCOL.md) first. In particular, never write the first 8 bytes of config memory, and always read in 8-byte blocks.
