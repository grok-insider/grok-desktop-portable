#!/usr/bin/env bash
# Copy VRMA Motion Pack (and optional VRM) from ~/Downloads into the SPA library.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$ROOT/apps/web/public/assets/aether/library"
ANIM="$LIB/animations"
LEGACY="$ROOT/apps/web/public/assets/aether/animations"
SRC_DEFAULT="${AETHER_VRMA_SRC:-$HOME/Downloads/VRMA_MotionPack/VRMA_MotionPack/vrma}"

mkdir -p "$ANIM" "$LIB/models" "$LEGACY"

if [[ ! -d "$SRC_DEFAULT" ]]; then
  echo "No VRMA source at $SRC_DEFAULT" >&2
  echo "Set AETHER_VRMA_SRC=… or unpack VRMA_MotionPack.zip under ~/Downloads" >&2
  exit 1
fi

copy_one() {
  local id="$1" label_file="$2"
  local src="$SRC_DEFAULT/${id}.vrma"
  if [[ -f "$src" ]]; then
    cp -f "$src" "$ANIM/${label_file}"
    echo "  + $label_file"
  else
    echo "  ! missing $src" >&2
  fi
}

echo "Syncing VRMA from $SRC_DEFAULT → $ANIM"
copy_one VRMA_01 VRMA_01_show_full_body.vrma
copy_one VRMA_02 VRMA_02_greeting.vrma
copy_one VRMA_03 VRMA_03_peace_sign.vrma
copy_one VRMA_04 VRMA_04_shoot.vrma
copy_one VRMA_05 VRMA_05_spin.vrma
copy_one VRMA_06 VRMA_06_model_pose.vrma
copy_one VRMA_07 VRMA_07_squat.vrma

# Product aliases (optional product-path load)
if [[ -f "$SRC_DEFAULT/VRMA_02.vrma" ]]; then
  cp -f "$SRC_DEFAULT/VRMA_02.vrma" "$LEGACY/idle.vrma"
  echo "  + legacy idle.vrma (greeting)"
fi
if [[ -f "$SRC_DEFAULT/VRMA_01.vrma" ]]; then
  cp -f "$SRC_DEFAULT/VRMA_01.vrma" "$LEGACY/speaking.vrma"
  echo "  + legacy speaking.vrma (show full body)"
fi

README_SRC="$(dirname "$SRC_DEFAULT")/Readme_VRMA_MotionPack_EN.txt"
if [[ -f "$README_SRC" ]]; then
  cp -f "$README_SRC" "$ANIM/Readme_VRMA_MotionPack_EN.txt"
fi

echo "Done. Catalog: $LIB/catalog.json"
echo "Credit: Animation credits to pixiv Inc.'s VRoid Project"
