#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: Debian packages must be built on Linux." >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64|amd64) NATIVE_ARCH="x64" ;;
  aarch64|arm64) NATIVE_ARCH="arm64" ;;
  armv7l|armv7*) NATIVE_ARCH="armv7l" ;;
  *) NATIVE_ARCH="$(uname -m)" ;;
esac

ARCHES="${ARCHES:-$NATIVE_ARCH}"
MODES="${MODES:-offline,online}"
EXPECTED_DEBIAN_MAJOR="${EXPECTED_DEBIAN_MAJOR:-10}"
ALLOW_NON_DEBIAN="${ALLOW_NON_DEBIAN:-0}"

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_VERSION_ID="${VERSION_ID:-unknown}"
else
  OS_ID="unknown"
  OS_VERSION_ID="unknown"
fi

if [[ "$ALLOW_NON_DEBIAN" != "1" ]]; then
  if [[ "$OS_ID" != "debian" || "${OS_VERSION_ID%%.*}" != "$EXPECTED_DEBIAN_MAJOR" ]]; then
    echo "ERROR: Build on Debian ${EXPECTED_DEBIAN_MAJOR}.x for Debian 10.10 compatibility." >&2
    echo "Detected: ${OS_ID} ${OS_VERSION_ID}" >&2
    echo "Set ALLOW_NON_DEBIAN=1 only for a deliberate compatibility test build." >&2
    exit 1
  fi
fi

for tool in awk node npm python3 dpkg-deb; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: Required tool not found: $tool" >&2
    exit 1
  fi
done

echo "Building Debian .deb packages"
echo "Modes: ${MODES}"
echo "Architectures: ${ARCHES}"
echo "Detected OS: ${OS_ID} ${OS_VERSION_ID}"
echo "Native arch: ${NATIVE_ARCH}"
echo
echo "Important: PyInstaller cannot cross-compile the Python backend."
echo "Run this script on Debian 10.x, preferably Debian 10.10, for the target CPU architecture."
echo "For arm64/armv7l, run on matching ARM hardware or an equivalent native builder."
echo "Override ARCHES only when your builder can produce a matching native Python backend."
echo

npm install --legacy-peer-deps
npm run package:linux -- --modes "${MODES}" --arch "${ARCHES}"

IFS=',' read -r -a MODE_LIST <<< "$MODES"
IFS=',' read -r -a ARCH_LIST <<< "$ARCHES"
for mode in "${MODE_LIST[@]}"; do
  for arch in "${ARCH_LIST[@]}"; do
    artifact="release/${mode}-debian/official-document-ai-assistant-${mode}-$(node -p "require('./package.json').version")-${arch}.deb"
    if [[ ! -f "$artifact" ]]; then
      echo "ERROR: Missing Debian artifact: $artifact" >&2
      exit 1
    fi
    echo
    echo "Verified artifact: $artifact"
    dpkg-deb -I "$artifact" | sed -n '1,25p'
    if ! dpkg-deb -c "$artifact" \
      | awk '$NF ~ /\/backend_server\/backend_server$/ { found=1 } END { exit(found ? 0 : 1) }'; then
      echo "ERROR: Packaged backend_server binary not found in $artifact" >&2
      exit 1
    fi
  done
done

node scripts/verify-packages.mjs \
  --skip-windows \
  --require-debian \
  "--debian-modes=${MODES}" \
  "--debian-arch=${ARCHES}"
