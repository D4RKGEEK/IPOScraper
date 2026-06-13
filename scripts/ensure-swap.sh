#!/usr/bin/env bash
#
# ensure-swap.sh — create swap ONLY when the box actually needs it.
#
# Decision (idempotent, safe to run on every deploy):
#   1. swap already active?            → do nothing
#   2. total RAM >= MIN_RAM_MB (2 GB)? → do nothing (enough memory to build)
#   3. otherwise                       → create SWAP_SIZE swap so builds don't OOM/hang
#
# Tunables via env: MIN_RAM_MB (default 2048), SWAP_SIZE (default 2G).
#
set -euo pipefail

SWAPFILE=/swapfile
MIN_RAM_MB="${MIN_RAM_MB:-2048}"
SWAP_SIZE="${SWAP_SIZE:-2G}"

# 1. Already have active swap → nothing to do.
if [[ "$(swapon --show --noheadings 2>/dev/null | wc -l)" -gt 0 ]]; then
  echo "swap: already active — skipping"
  exit 0
fi

# 2. Plenty of RAM → swap not needed.
total_ram_mb="$(free -m | awk '/^Mem:/{print $2}')"
if [[ "${total_ram_mb:-0}" -ge "$MIN_RAM_MB" ]]; then
  echo "swap: RAM ${total_ram_mb}MB >= ${MIN_RAM_MB}MB — not needed, skipping"
  exit 0
fi

# 3. Low RAM and no swap → create it.
echo "swap: RAM ${total_ram_mb}MB < ${MIN_RAM_MB}MB and none present — creating ${SWAP_SIZE}"
if [[ ! -f "$SWAPFILE" ]]; then
  fallocate -l "$SWAP_SIZE" "$SWAPFILE" 2>/dev/null \
    || dd if=/dev/zero of="$SWAPFILE" bs=1M count=2048 status=none
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE" >/dev/null
fi
swapon "$SWAPFILE"
grep -q "^$SWAPFILE " /etc/fstab 2>/dev/null \
  || echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab   # persist across reboots
echo "swap: ✓ ${SWAP_SIZE} enabled"
