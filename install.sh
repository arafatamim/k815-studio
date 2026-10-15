#!/bin/sh
# Install the K815 macropad udev rule so Chromium's WebHID can open the device.
#
# Chromium reaches the pad through /dev/hidraw*, which is root-only by default on
# Linux; without this rule the web app fails with "Failed to open the device".
# Needs root (sudo). Safe to re-run.
set -eu

RULE_NAME="99-k815-macropad.rules"
SRC_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC="$SRC_DIR/$RULE_NAME"
DEST_DIR="/etc/udev/rules.d"
DEST="$DEST_DIR/$RULE_NAME"

if [ ! -f "$SRC" ]; then
  echo "error: $RULE_NAME not found next to this script ($SRC_DIR)" >&2
  exit 1
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    echo "error: need root; re-run with sudo." >&2
    exit 1
  fi
fi

echo "Installing $RULE_NAME -> $DEST"
$SUDO install -m 0644 "$SRC" "$DEST"

$SUDO udevadm control --reload-rules
$SUDO udevadm trigger --subsystem-match=hidraw

echo
echo "Done. Unplug and replug the K815, then reload the web app."
echo "Verify with:  ls -l /dev/hidraw*   (the K815 nodes should no longer be root-only)"
