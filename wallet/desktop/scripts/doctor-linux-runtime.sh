#!/usr/bin/env bash
set -euo pipefail

missing=0
missing_pkgs=()
AUTO_FIX=0

if [[ "${1:-}" == "--fix" ]]; then
  AUTO_FIX=1
fi

check_pc() {
  local pkg="$1"
  if pkg-config --exists "$pkg"; then
    echo "✅ Found pkg-config entry: $pkg"
  else
    echo "❌ Missing pkg-config entry: $pkg"
    missing=1
    missing_pkgs+=("$pkg")
  fi
}

find_pc_hints() {
  local pkg="$1"
  local found=0
  while IFS= read -r pcfile; do
    found=1
    local pcdir
    pcdir="$(dirname "$pcfile")"
    echo "   ↳ found ${pkg}.pc at: $pcfile"
    echo "     export PKG_CONFIG_PATH=\"$pcdir:\$PKG_CONFIG_PATH\""
  done < <(find /usr /usr/local /opt -type f -name "${pkg}.pc" 2>/dev/null | head -n 5)

  if [[ $found -eq 0 ]]; then
    echo "   ↳ no ${pkg}.pc file found under /usr, /usr/local, or /opt"
  fi
}

detect_os_family() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck source=/dev/null
    . /etc/os-release
    case "${ID:-}" in
      ubuntu|debian|linuxmint|pop) echo "debian" ;;
      fedora|rhel|centos|rocky|almalinux) echo "fedora" ;;
      arch|manjaro|endeavouros) echo "arch" ;;
      *) echo "unknown" ;;
    esac
  else
    echo "unknown"
  fi
}

attempt_auto_fix() {
  local os_family
  os_family="$(detect_os_family)"
  echo "Attempting automatic install for OS family: ${os_family}"
  case "$os_family" in
    debian)
      sudo apt-get update
      sudo apt-get install -y libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev
      ;;
    fedora)
      sudo dnf install -y webkit2gtk4.1-devel javascriptcoregtk4.1-devel
      ;;
    arch)
      sudo pacman -Sy --noconfirm webkit2gtk-4.1
      ;;
    *)
      echo "Auto-fix is not supported for this distro. Install packages manually."
      return 1
      ;;
  esac
}

echo "Checking Linux desktop runtime prerequisites for Tauri/WebKitGTK..."
check_pc javascriptcoregtk-4.1
check_pc webkit2gtk-4.1

if [[ $missing -eq 1 ]]; then
  if [[ $AUTO_FIX -eq 1 ]]; then
    attempt_auto_fix || true
    # Re-check after attempted install.
    missing=0
    missing_pkgs=()
    check_pc javascriptcoregtk-4.1
    check_pc webkit2gtk-4.1
  fi
fi

if [[ $missing -eq 1 ]]; then
  cat <<'MSG'

One or more native runtime dependencies are missing.
Install the WebKitGTK/JavascriptCore development packages for your distro, then retry:

  Ubuntu/Debian:
    sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev

  Fedora:
    sudo dnf install webkit2gtk4.1-devel javascriptcoregtk4.1-devel

  Arch:
    sudo pacman -S webkit2gtk-4.1

After installing, rerun:
  pnpm doctor:linux
  # or try automatic installation:
  bash ./scripts/doctor-linux-runtime.sh --fix
  pnpm tauri:dev
MSG
  echo
  echo "PKG_CONFIG_PATH diagnostics:"
  for pkg in "${missing_pkgs[@]}"; do
    find_pc_hints "$pkg"
  done
  exit 1
fi

echo "All required pkg-config entries detected. You can run: pnpm tauri:dev"
