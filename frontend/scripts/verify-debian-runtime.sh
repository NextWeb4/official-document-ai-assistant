#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

MODE="${MODE:-offline}"
ARCH="${ARCH:-}"
KEEP_INSTALLED="${KEEP_INSTALLED:-0}"
PORT="${PORT:-8765}"
ALLOW_NON_RELEASE_OS="${ALLOW_NON_RELEASE_OS:-0}"
ALLOW_NON_RELEASE_NO_GUI="${ALLOW_NON_RELEASE_NO_GUI:-0}"
APP_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -n1)"

usage() {
  cat <<'EOF'
Usage:
  MODE=offline ARCH=x64 bash scripts/verify-debian-runtime.sh
  MODE=online ARCH=arm64 KEEP_INSTALLED=1 bash scripts/verify-debian-runtime.sh

Environment:
  MODE                      offline or online
  ARCH                      x64, arm64, or armv7l. Defaults to the current machine arch.
  KEEP_INSTALLED            set to 1 to leave the package installed after verification.
  PORT                      backend health port, defaults to 8765.
  ALLOW_NON_RELEASE_OS      set to 1 only for a deliberate structural/runtime check
                            outside Debian 10.x. Release acceptance must not use it.
  ALLOW_NON_RELEASE_NO_GUI  set to 1 only for a non-release structural check when neither
                            DISPLAY nor xvfb-run is available. Release acceptance must not use it.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "ERROR: runtime verification must run on Linux/Debian." >&2
  exit 1
fi

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_VERSION_ID="${VERSION_ID:-unknown}"
else
  OS_ID="unknown"
  OS_VERSION_ID="unknown"
fi

case "$ALLOW_NON_RELEASE_OS" in
  0|1) ;;
  *) echo "ERROR: ALLOW_NON_RELEASE_OS must be 0 or 1." >&2; exit 1 ;;
esac

if [[ "$OS_ID" != "debian" || "${OS_VERSION_ID%%.*}" != "10" ]]; then
  if [[ "$ALLOW_NON_RELEASE_OS" != "1" ]]; then
    echo "ERROR: release runtime verification requires Debian 10.x; detected ${OS_ID} ${OS_VERSION_ID}." >&2
    echo "For a deliberate non-release check only, set ALLOW_NON_RELEASE_OS=1." >&2
    exit 1
  fi
  echo "NON-RELEASE OVERRIDE: expected Debian 10.x, detected ${OS_ID} ${OS_VERSION_ID}." >&2
fi

if [[ -z "$ARCH" ]]; then
  case "$(uname -m)" in
    x86_64|amd64) ARCH="x64" ;;
    aarch64|arm64) ARCH="arm64" ;;
    armv7l|armv7*) ARCH="armv7l" ;;
    *) echo "ERROR: unsupported machine architecture: $(uname -m)" >&2; exit 1 ;;
  esac
fi

case "$MODE" in
  offline|online) ;;
  *) echo "ERROR: MODE must be offline or online." >&2; exit 1 ;;
esac

case "$ARCH" in
  x64) DEB_ARCH="amd64" ;;
  arm64) DEB_ARCH="arm64" ;;
  armv7l) DEB_ARCH="armhf" ;;
  *) echo "ERROR: ARCH must be x64, arm64, or armv7l." >&2; exit 1 ;;
esac

case "$ALLOW_NON_RELEASE_NO_GUI" in
  0|1) ;;
  *) echo "ERROR: ALLOW_NON_RELEASE_NO_GUI must be 0 or 1." >&2; exit 1 ;;
esac

PACKAGE="official-document-ai-assistant-${MODE}"
DEB="release/${MODE}-debian/${PACKAGE}-${APP_VERSION}-${ARCH}.deb"
APP_DIR="/opt/${PACKAGE}"
ELECTRON="${APP_DIR}/${PACKAGE}"
BACKEND="${APP_DIR}/resources/backend_server/backend_server"
APP_DATA="$(mktemp -d)"
XDG_CONFIG_HOME="${APP_DATA}/config"
XDG_STATE_HOME="${APP_DATA}/state"
HEALTH_FILE="${APP_DATA}/health.json"
ELECTRON_LOG="${APP_DATA}/electron.log"
LAUNCHER_LOG="${XDG_STATE_HOME}/${PACKAGE}/launcher.log"
LIBREOFFICE_BEFORE="${APP_DATA}/libreoffice-before.txt"
LIBREOFFICE_AFTER="${APP_DATA}/libreoffice-after.txt"
APP_PID=""
ELECTRON_PID=""
BACKEND_PID=""

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required tool not found: $1" >&2
    exit 1
  fi
}

verify_dynamic_links() {
  local candidate
  local candidate_dir
  local magic
  local output
  local failed=0
  local runtime_library_path="${APP_DIR}:${APP_DIR}/resources/python/lib:${LD_LIBRARY_PATH:-}"

  while IFS= read -r -d '' candidate; do
    magic="$(LC_ALL=C od -An -N4 -t x1 "$candidate" 2>/dev/null | tr -d ' \n')"
    [[ "$magic" == "7f454c46" ]] || continue
    candidate_dir="$(dirname "$candidate")"

    if ! output="$(LC_ALL=C LD_LIBRARY_PATH="${candidate_dir}:${runtime_library_path}" ldd "$candidate" 2>&1)"; then
      if grep -Eqi 'not a dynamic executable|statically linked' <<<"$output"; then
        continue
      fi
      echo "ERROR: dynamic loader rejected $candidate" >&2
      echo "$output" >&2
      failed=1
      continue
    fi
    if grep -q 'not found' <<<"$output"; then
      echo "ERROR: unresolved shared library for $candidate" >&2
      echo "$output" >&2
      failed=1
    fi
  done < <(find "$APP_DIR" -type f -print0)

  if [[ "$failed" != "0" ]]; then
    return 1
  fi
}

list_installed_libreoffice() {
  local packages
  packages="$(dpkg-query -W -f='${binary:Package}\t${Status}\n' 'libreoffice*' 2>/dev/null || true)"
  printf '%s' "$packages" \
    | awk -F '\t' '$2 == "install ok installed" { print $1 }' \
    | sort -u
}

process_exe() {
  readlink -f "/proc/$1/exe" 2>/dev/null || true
}

process_cmdline() {
  tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null || true
}

process_ppid() {
  awk '/^PPid:/ { print $2; exit }' "/proc/$1/status" 2>/dev/null || true
}

is_descendant_or_self() {
  local candidate="$1"
  local ancestor="$2"
  local parent
  local hops=0

  while [[ "$candidate" =~ ^[0-9]+$ ]] && (( candidate > 1 )) && (( hops < 100 )); do
    if [[ "$candidate" == "$ancestor" ]]; then
      return 0
    fi
    parent="$(process_ppid "$candidate")"
    if [[ -z "$parent" || "$parent" == "$candidate" ]]; then
      break
    fi
    candidate="$parent"
    hops=$((hops + 1))
  done
  return 1
}

matches_installed_process() {
  local pid="$1"
  local exe
  local cmdline
  exe="$(process_exe "$pid")"
  cmdline="$(process_cmdline "$pid")"

  [[ "$exe" == "$APP_DIR/"* ]] && return 0
  [[ "$cmdline" == *"/usr/bin/${PACKAGE}"* ]] && return 0
  [[ "$cmdline" == *"${APP_DIR}/resources/"* ]] && return 0
  return 1
}

list_installed_processes() {
  local proc
  local pid
  for proc in /proc/[0-9]*; do
    [[ -d "$proc" ]] || continue
    pid="${proc##*/}"
    [[ "$pid" != "$$" ]] || continue
    if matches_installed_process "$pid"; then
      printf '%s\n' "$pid"
    fi
  done
}

stop_installed_processes() {
  local pids
  local pid
  local remaining

  pids="$(list_installed_processes)"
  if [[ -z "$pids" ]]; then
    return 0
  fi

  echo "Stopping stale installed application processes: $(echo "$pids" | paste -sd ',')"
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && kill "$pid" >/dev/null 2>&1 || true
  done <<<"$pids"

  for _ in $(seq 1 20); do
    remaining="$(list_installed_processes)"
    [[ -z "$remaining" ]] && return 0
    sleep 0.25
  done

  remaining="$(list_installed_processes)"
  while IFS= read -r pid; do
    [[ -n "$pid" ]] && kill -KILL "$pid" >/dev/null 2>&1 || true
  done <<<"$remaining"
  sleep 0.25

  remaining="$(list_installed_processes)"
  if [[ -n "$remaining" ]]; then
    echo "ERROR: installed application processes did not stop: $(echo "$remaining" | paste -sd ',')" >&2
    return 1
  fi
}

find_electron_pid() {
  local ancestor="$1"
  local expected_exe
  local proc
  local pid
  local exe
  local cmdline
  expected_exe="$(readlink -f "$ELECTRON")"

  for proc in /proc/[0-9]*; do
    [[ -d "$proc" ]] || continue
    pid="${proc##*/}"
    exe="$(process_exe "$pid")"
    [[ "$exe" == "$expected_exe" ]] || continue
    is_descendant_or_self "$pid" "$ancestor" || continue
    cmdline="$(process_cmdline "$pid")"
    [[ "$cmdline" != *"--type="* ]] || continue
    printf '%s\n' "$pid"
    return 0
  done
  return 1
}

find_renderer_pid() {
  local electron_pid="$1"
  local proc
  local pid
  local cmdline
  for proc in /proc/[0-9]*; do
    [[ -d "$proc" ]] || continue
    pid="${proc##*/}"
    [[ "$pid" != "$electron_pid" ]] || continue
    is_descendant_or_self "$pid" "$electron_pid" || continue
    cmdline="$(process_cmdline "$pid")"
    if [[ "$cmdline" == *"--type=renderer"* ]]; then
      printf '%s\n' "$pid"
      return 0
    fi
  done
  return 1
}

matches_backend_process() {
  local pid="$1"
  local exe
  local backend_exe
  local cmdline
  exe="$(process_exe "$pid")"
  backend_exe="$(readlink -f "$BACKEND")"
  cmdline="$(process_cmdline "$pid")"

  [[ "$exe" == "$backend_exe" ]] && return 0
  [[ "$cmdline" == *"${BACKEND}"* ]] && return 0
  if [[ "$cmdline" == *"${APP_DIR}/resources/python/"* && "$cmdline" == *"frozen_main"* ]]; then
    return 0
  fi
  return 1
}

find_backend_pid() {
  local electron_pid="$1"
  local proc
  local pid
  for proc in /proc/[0-9]*; do
    [[ -d "$proc" ]] || continue
    pid="${proc##*/}"
    [[ "$pid" != "$electron_pid" ]] || continue
    is_descendant_or_self "$pid" "$electron_pid" || continue
    if matches_backend_process "$pid"; then
      printf '%s\n' "$pid"
      return 0
    fi
  done
  return 1
}

show_electron_log() {
  if [[ -s "$ELECTRON_LOG" ]]; then
    echo "--- Electron log ---" >&2
    cat "$ELECTRON_LOG" >&2 || true
  fi
  if [[ -s "$LAUNCHER_LOG" ]]; then
    echo "--- Persistent launcher log ---" >&2
    cat "$LAUNCHER_LOG" >&2 || true
  fi
}

port_is_bindable() {
  local port_hex
  if command -v python3 >/dev/null 2>&1; then
    PORT_TO_CHECK="$PORT" python3 - <<'PY'
import os
import socket

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    sock.bind(("127.0.0.1", int(os.environ["PORT_TO_CHECK"])))
except OSError:
    raise SystemExit(1)
finally:
    sock.close()
PY
    return
  fi

  port_hex="$(printf '%04X' "$PORT")"
  ! awk -v port=":${port_hex}" '
    $2 ~ port "$" && $4 == "0A" { listening=1 }
    END { exit(listening ? 0 : 1) }
  ' /proc/net/tcp /proc/net/tcp6 2>/dev/null
}

list_port_listener_pids() {
  local port_hex
  local socket_inodes
  local proc
  local pid
  local fd
  local target
  local inode

  port_hex="$(printf '%04X' "$PORT")"
  socket_inodes="$(awk -v port=":${port_hex}" '
    $2 ~ port "$" && $4 == "0A" && $10 != "0" { print $10 }
  ' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u)"
  [[ -n "$socket_inodes" ]] || return 0

  for proc in /proc/[0-9]*; do
    [[ -d "$proc/fd" ]] || continue
    pid="${proc##*/}"
    for fd in "$proc"/fd/*; do
      [[ -e "$fd" || -L "$fd" ]] || continue
      target="$(readlink "$fd" 2>/dev/null || true)"
      [[ "$target" == socket:\[*\] ]] || continue
      inode="${target#socket:[}"
      inode="${inode%]}"
      if grep -qx "$inode" <<<"$socket_inodes"; then
        printf '%s\n' "$pid"
        break
      fi
    done
  done
}

stop_backend_port_owners() {
  local pids
  local pid
  local remaining

  pids="$(list_port_listener_pids)"
  [[ -n "$pids" ]] || return 0
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if ! matches_backend_process "$pid"; then
      echo "ERROR: refusing to stop unrecognized port owner PID ${pid}." >&2
      return 1
    fi
    kill "$pid" >/dev/null 2>&1 || true
  done <<<"$pids"

  for _ in $(seq 1 20); do
    remaining="$(list_port_listener_pids)"
    [[ -z "$remaining" ]] && return 0
    sleep 0.25
  done
  remaining="$(list_port_listener_pids)"
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    matches_backend_process "$pid" || return 1
    kill -KILL "$pid" >/dev/null 2>&1 || true
  done <<<"$remaining"
  for _ in $(seq 1 20); do
    [[ -z "$(list_port_listener_pids)" ]] && return 0
    sleep 0.25
  done
  return 1
}

stop_known_backend() {
  if [[ -z "$BACKEND_PID" ]] \
    || ! kill -0 "$BACKEND_PID" >/dev/null 2>&1 \
    || ! matches_backend_process "$BACKEND_PID"; then
    return 0
  fi

  kill "$BACKEND_PID" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    port_is_bindable && return 0
    sleep 0.25
  done

  if kill -0 "$BACKEND_PID" >/dev/null 2>&1 \
    && matches_backend_process "$BACKEND_PID"; then
    kill -KILL "$BACKEND_PID" >/dev/null 2>&1 || true
  fi
  for _ in $(seq 1 20); do
    port_is_bindable && return 0
    sleep 0.25
  done
  return 1
}

cleanup() {
  local cleanup_failed=0
  if ! stop_known_backend; then
    echo "ERROR: known backend process did not release 127.0.0.1:${PORT}." >&2
    cleanup_failed=1
  fi
  if [[ -n "$ELECTRON_PID" ]] && kill -0 "$ELECTRON_PID" >/dev/null 2>&1; then
    kill "$ELECTRON_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" >/dev/null 2>&1; then
    kill "$APP_PID" >/dev/null 2>&1 || true
    wait "$APP_PID" >/dev/null 2>&1 || true
  fi
  if ! stop_installed_processes >/dev/null 2>&1; then
    echo "ERROR: failed to stop installed application processes during cleanup." >&2
    cleanup_failed=1
  fi
  if ! stop_backend_port_owners; then
    echo "ERROR: failed to stop the recognized backend port owner." >&2
    cleanup_failed=1
  fi
  for _ in $(seq 1 40); do
    if port_is_bindable; then
      break
    fi
    sleep 0.25
  done
  if ! port_is_bindable; then
    echo "ERROR: backend port remained unavailable after cleanup: 127.0.0.1:${PORT}." >&2
    cleanup_failed=1
  fi
  rm -rf "$APP_DATA"
  if [[ "$KEEP_INSTALLED" != "1" ]]; then
    if command -v sudo >/dev/null 2>&1; then
      sudo dpkg -r "$PACKAGE" >/dev/null 2>&1 || true
    else
      dpkg -r "$PACKAGE" >/dev/null 2>&1 || true
    fi
  fi
  if [[ "$cleanup_failed" != "0" ]]; then
    exit 1
  fi
}
trap cleanup EXIT

require_tool dpkg
require_tool dpkg-deb
require_tool dpkg-query
require_tool comm
require_tool curl
require_tool dirname
require_tool find
require_tool ldd
require_tool od
require_tool readlink
require_tool tr

if [[ ! -f "$DEB" ]]; then
  echo "ERROR: missing artifact: $DEB" >&2
  exit 1
fi

if ! dpkg-deb -f "$DEB" Package | grep -qx "$PACKAGE"; then
  echo "ERROR: unexpected package name in $DEB" >&2
  exit 1
fi
if ! dpkg-deb -f "$DEB" Architecture | grep -qx "$DEB_ARCH"; then
  echo "ERROR: unexpected architecture in $DEB" >&2
  exit 1
fi

list_installed_libreoffice >"$LIBREOFFICE_BEFORE"
echo "Installing $DEB"
if command -v sudo >/dev/null 2>&1; then
  sudo dpkg -i "$DEB" || sudo apt-get install -f -y --no-install-recommends
else
  dpkg -i "$DEB" || apt-get install -f -y --no-install-recommends
fi

if ! dpkg-query -W -f='${Status}\n' "$PACKAGE" 2>/dev/null | grep -qx 'install ok installed'; then
  echo "ERROR: document assistant package is not installed after dpkg/apt completed." >&2
  exit 1
fi

mapfile -t ELECTRON_CANDIDATES < <(
  find /opt -mindepth 2 -maxdepth 2 -type f -name "$PACKAGE" -perm /111 -print
)
if [[ "${#ELECTRON_CANDIDATES[@]}" != "1" ]]; then
  echo "ERROR: expected exactly one installed Electron executable for $PACKAGE; found ${#ELECTRON_CANDIDATES[@]}." >&2
  printf '  %s\n' "${ELECTRON_CANDIDATES[@]}" >&2
  exit 1
fi
ELECTRON="${ELECTRON_CANDIDATES[0]}"
APP_DIR="$(dirname "$ELECTRON")"
BACKEND="${APP_DIR}/resources/backend_server/backend_server"

list_installed_libreoffice >"$LIBREOFFICE_AFTER"
NEW_LIBREOFFICE_PACKAGES="$(comm -13 "$LIBREOFFICE_BEFORE" "$LIBREOFFICE_AFTER")"
if [[ -n "$NEW_LIBREOFFICE_PACKAGES" ]]; then
  echo "ERROR: installing the document assistant also installed LibreOffice packages:" >&2
  echo "$NEW_LIBREOFFICE_PACKAGES" >&2
  exit 1
fi

test -x "/usr/bin/${PACKAGE}"
test -x "$ELECTRON"
test -x "$BACKEND"
test -f "/usr/share/applications/${PACKAGE}.desktop"
test -f "${APP_DIR}/resources/app.asar"
test -f "${APP_DIR}/resources/rules/official/fujian_province.yaml"
test -f "${APP_DIR}/resources/templates/official/fujian_province.yaml"

verify_dynamic_links

FUJIAN_RULES="$(find "${APP_DIR}/resources/rules/official" -maxdepth 1 -name 'fujian*.yaml' -printf '%f\n' | sort | paste -sd ',')"
FUJIAN_TEMPLATES="$(find "${APP_DIR}/resources/templates/official" -maxdepth 1 -name 'fujian*.yaml' -printf '%f\n' | sort | paste -sd ',')"
if [[ "$FUJIAN_RULES" != "fujian_province.yaml" ]]; then
  echo "ERROR: unexpected Fujian rules: $FUJIAN_RULES" >&2
  exit 1
fi
if [[ "$FUJIAN_TEMPLATES" != "fujian_province.yaml" ]]; then
  echo "ERROR: unexpected Fujian templates: $FUJIAN_TEMPLATES" >&2
  exit 1
fi

stop_installed_processes
rm -f "$HEALTH_FILE"
if curl -fsS --connect-timeout 1 --max-time 1 "http://127.0.0.1:${PORT}/api/health" >"$HEALTH_FILE" 2>/dev/null; then
  echo "ERROR: backend health endpoint was already active before Electron launch." >&2
  exit 1
fi
if [[ -n "$(list_installed_processes)" ]]; then
  echo "ERROR: stale installed application process remained before Electron launch." >&2
  exit 1
fi

GUI_STRATEGY=""
if [[ -n "${DISPLAY:-}" ]]; then
  GUI_STRATEGY="display"
elif command -v xvfb-run >/dev/null 2>&1; then
  GUI_STRATEGY="xvfb"
elif [[ "$ALLOW_NON_RELEASE_NO_GUI" == "1" ]]; then
  echo "NON-RELEASE OVERRIDE: no DISPLAY or xvfb-run; GUI runtime verification was not performed." >&2
  echo "Structural installation checks passed, but this result is not valid for release acceptance."
  exit 0
else
  echo "ERROR: Electron GUI verification requires DISPLAY or xvfb-run." >&2
  echo "For a non-release structural check only, set ALLOW_NON_RELEASE_NO_GUI=1." >&2
  exit 1
fi

mkdir -p "$XDG_CONFIG_HOME" "$XDG_STATE_HOME"
if [[ "$GUI_STRATEGY" == "display" ]]; then
  echo "Starting installed Electron launcher on DISPLAY=${DISPLAY}"
  APP_MODE="$MODE" APP_DATA_DIR="$APP_DATA" XDG_CONFIG_HOME="$XDG_CONFIG_HOME" \
    XDG_STATE_HOME="$XDG_STATE_HOME" \
    "/usr/bin/${PACKAGE}" >"$ELECTRON_LOG" 2>&1 &
else
  echo "Starting installed Electron launcher under xvfb"
  APP_MODE="$MODE" APP_DATA_DIR="$APP_DATA" XDG_CONFIG_HOME="$XDG_CONFIG_HOME" \
    XDG_STATE_HOME="$XDG_STATE_HOME" \
    xvfb-run -a "/usr/bin/${PACKAGE}" >"$ELECTRON_LOG" 2>&1 &
fi
APP_PID="$!"

for _ in $(seq 1 60); do
  if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
    echo "ERROR: Electron launcher exited before the Electron main process was found." >&2
    show_electron_log
    exit 1
  fi
  ELECTRON_PID="$(find_electron_pid "$APP_PID" || true)"
  [[ -n "$ELECTRON_PID" ]] && break
  sleep 0.5
done

if [[ -z "$ELECTRON_PID" ]] || ! kill -0 "$ELECTRON_PID" >/dev/null 2>&1; then
  echo "ERROR: installed Electron main process did not stay alive." >&2
  show_electron_log
  exit 1
fi

rm -f "$HEALTH_FILE"
for _ in $(seq 1 120); do
  if ! kill -0 "$ELECTRON_PID" >/dev/null 2>&1; then
    echo "ERROR: Electron main process exited before backend health became ready." >&2
    show_electron_log
    exit 1
  fi
  BACKEND_PID="$(find_backend_pid "$ELECTRON_PID" || true)"
  if [[ -n "$BACKEND_PID" ]] \
    && kill -0 "$BACKEND_PID" >/dev/null 2>&1 \
    && curl -fsS --connect-timeout 1 --max-time 2 "http://127.0.0.1:${PORT}/api/health" >"$HEALTH_FILE" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if [[ -z "$BACKEND_PID" ]] || ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
  echo "ERROR: Electron did not launch a recognizable backend child process." >&2
  show_electron_log
  exit 1
fi
if ! is_descendant_or_self "$BACKEND_PID" "$ELECTRON_PID"; then
  echo "ERROR: backend pid ${BACKEND_PID} is not a descendant of Electron pid ${ELECTRON_PID}." >&2
  show_electron_log
  exit 1
fi
if [[ ! -s "$HEALTH_FILE" ]]; then
  echo "ERROR: Electron-launched backend health check failed." >&2
  show_electron_log
  exit 1
fi

RENDERER_PID=""
WINDOW_SHOWN=0
for _ in $(seq 1 40); do
  RENDERER_PID="$(find_renderer_pid "$ELECTRON_PID" || true)"
  if [[ -n "$RENDERER_PID" ]] \
    && { grep -q 'Window shown' "$LAUNCHER_LOG" 2>/dev/null \
      || grep -q 'Window shown' "$ELECTRON_LOG" 2>/dev/null; }; then
    WINDOW_SHOWN=1
    break
  fi
  sleep 0.5
done
if [[ -z "$RENDERER_PID" ]] || ! kill -0 "$RENDERER_PID" >/dev/null 2>&1; then
  echo "ERROR: Electron did not keep a renderer process alive." >&2
  show_electron_log
  exit 1
fi
if [[ "$WINDOW_SHOWN" != "1" ]]; then
  echo "ERROR: Electron never reported that its window was shown." >&2
  show_electron_log
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  EXPECTED_MODE="$MODE" HEALTH_FILE="$HEALTH_FILE" python3 - <<'PY'
import json
import os

with open(os.environ["HEALTH_FILE"], "r", encoding="utf-8") as fh:
    health = json.load(fh)
expected = os.environ["EXPECTED_MODE"]
if health.get("status") != "ok":
    raise SystemExit(f"bad status: {health}")
if health.get("app_mode") != expected:
    raise SystemExit(f"expected app_mode={expected}, got {health.get('app_mode')}")
PY
else
  grep -q '"status"[[:space:]]*:[[:space:]]*"ok"' "$HEALTH_FILE"
  grep -q "\"app_mode\"[[:space:]]*:[[:space:]]*\"${MODE}\"" "$HEALTH_FILE"
fi

sleep 1
if ! kill -0 "$ELECTRON_PID" >/dev/null 2>&1; then
  echo "ERROR: Electron main process did not remain alive after backend readiness." >&2
  show_electron_log
  exit 1
fi
if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
  echo "ERROR: Electron-launched backend did not remain alive after readiness." >&2
  show_electron_log
  exit 1
fi

echo "Runtime verification passed for ${PACKAGE} ${ARCH} on ${OS_ID} ${OS_VERSION_ID} (electron=${ELECTRON_PID}, renderer=${RENDERER_PID}, backend=${BACKEND_PID}, app_mode=${MODE})."
