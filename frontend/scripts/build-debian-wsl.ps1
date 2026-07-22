param(
  [string]$Distro = "Debian",
  [string]$Modes = "offline,online",
  [string]$Archs = "",
  [switch]$AllowNonDebian,
  [switch]$SkipAptInstall
)

$ErrorActionPreference = "Stop"

$NodeVersion = "20.19.5"
$PythonVersion = "3.12.7"
# Digest recorded in Python.org's Python-3.12.7.tar.xz.sigstore bundle.
$PythonSourceSha256 = "24887b92e2afd4a2ac602419ad4b596372f67ac9b077190f459aba390faf5550"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$FrontendDir = Resolve-Path (Join-Path $ScriptDir "..")
$ProjectRoot = Resolve-Path (Join-Path $FrontendDir "..")
$BuildRoot = "/var/tmp/official-document-ai-assistant-wsl-$PID"

function Invoke-Wsl([string]$Command, [string]$Description = "WSL command") {
  Write-Host ">>> $Description"
  & wsl -d $Distro -u root -- bash -lc $Command
  if ($LASTEXITCODE -ne 0) {
    throw "WSL command failed ($LASTEXITCODE): $Description"
  }
}

function Read-Wsl([string]$Command) {
  $output = & wsl -d $Distro -u root -- bash -lc $Command
  if ($LASTEXITCODE -ne 0) {
    throw "WSL command failed ($LASTEXITCODE): $Command"
  }
  return ($output -join "`n").Trim()
}

function Convert-ToWslPath([string]$Path) {
  $resolved = Resolve-Path $Path
  $converted = (& wsl -d $Distro -u root -- wslpath -a $resolved.Path).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $converted) {
    throw "Failed to convert Windows path to WSL path: $Path"
  }
  return $converted
}

function Quote-Bash([string]$Value) {
  $escapedQuote = "'" + [char]34 + "'" + [char]34 + "'"
  return "'" + $Value.Replace("'", $escapedQuote) + "'"
}

$wsl = Get-Command wsl -ErrorAction SilentlyContinue
if (-not $wsl) {
  throw "WSL is required, but wsl.exe was not found."
}

& wsl -d $Distro -u root -- bash -lc "cat /etc/os-release >/dev/null && uname -m >/dev/null"
if ($LASTEXITCODE -ne 0) {
  throw "WSL distro '$Distro' is not usable yet. Reboot Windows if WSL was just enabled, then initialize Debian before running this script."
}

$osInfo = Read-Wsl '. /etc/os-release; printf "%s|%s" "$ID" "$VERSION_ID"'
$osParts = $osInfo.Split('|', 2)
$osId = $osParts[0]
$osVersion = if ($osParts.Count -gt 1) { $osParts[1] } else { "unknown" }
$osMajor = $osVersion.Split('.')[0]
if (($osId -ne "debian" -or $osMajor -ne "10") -and -not $AllowNonDebian) {
  throw "Debian 10.x is required for release packaging; detected $osId $osVersion. Pass -AllowNonDebian only for a deliberate non-release compatibility build."
}

$nativeMachine = Read-Wsl "uname -m"
$nativeArch = switch -Regex ($nativeMachine) {
  '^(x86_64|amd64)$' { "x64"; break }
  '^(aarch64|arm64)$' { "arm64"; break }
  '^armv7' { "armv7l"; break }
  default { throw "Unsupported WSL architecture: $nativeMachine" }
}
if ($Archs) {
  $requestedArchs = $Archs.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
  $foreignArchs = $requestedArchs | Where-Object { $_ -ne $nativeArch }
  if ($foreignArchs) {
    throw "WSL packaging cannot cross-compile the PyInstaller backend. Requested '$Archs', but '$Distro' is $nativeArch."
  }
}

$projectRootWsl = Convert-ToWslPath $ProjectRoot.Path
$frontendWsl = Convert-ToWslPath $FrontendDir.Path
$quotedBuildRoot = Quote-Bash $BuildRoot
$quotedProjectRoot = Quote-Bash $projectRootWsl
$quotedFrontend = Quote-Bash $frontendWsl

try {
  if (-not $SkipAptInstall) {
    if ($osId -eq "debian" -and $osMajor -eq "10") {
      Invoke-Wsl @'
set -euo pipefail
sed -i \
  -e 's/deb.debian.org/archive.debian.org/g' \
  -e 's/security.debian.org/archive.debian.org/g' \
  -e '/buster-updates/d' \
  /etc/apt/sources.list
printf 'Acquire::Check-Valid-Until "false";\n' >/etc/apt/apt.conf.d/99archive-valid-until
'@ "Configure archived Debian 10 package sources"
    }

    Invoke-Wsl @'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  bash ca-certificates curl dpkg-dev fakeroot file gcc g++ git make perl rsync xz-utils \
  zlib1g-dev libbz2-dev libffi-dev libgdbm-dev liblzma-dev libncursesw5-dev \
  libreadline-dev libsqlite3-dev libssl-dev uuid-dev
'@ "Install Debian build prerequisites"
  }

  $provision = @'
set -euo pipefail
node_version='__NODE_VERSION__'
python_version='__PYTHON_VERSION__'
python_sha256='__PYTHON_SHA256__'
runtime_root='/opt/official-document-ai-assistant-build'

for tool in curl make sha256sum tar xz; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required provisioning tool not found: $tool" >&2
    exit 1
  fi
done

case "$(uname -m)" in
  x86_64|amd64) node_arch='x64' ;;
  aarch64|arm64) node_arch='arm64' ;;
  armv7l|armv7*) node_arch='armv7l' ;;
  *) echo "ERROR: unsupported Node.js architecture: $(uname -m)" >&2; exit 1 ;;
esac

node_root="$runtime_root/node-v$node_version"
if [[ ! -x "$node_root/bin/node" ]] || [[ "$($node_root/bin/node -p 'process.versions.node' 2>/dev/null || true)" != "$node_version" ]]; then
  archive="node-v${node_version}-linux-${node_arch}.tar.xz"
  work_dir="$(mktemp -d)"
  trap 'rm -rf "$work_dir"' EXIT
  curl -fsSLo "$work_dir/$archive" "https://nodejs.org/dist/v${node_version}/$archive"
  curl -fsSLo "$work_dir/SHASUMS256.txt" "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt"
  (cd "$work_dir" && grep -E "^[0-9a-f]{64}  ${archive}$" SHASUMS256.txt | sha256sum -c -)
  rm -rf "$node_root"
  mkdir -p "$node_root"
  tar -xJf "$work_dir/$archive" -C "$node_root" --strip-components=1
  rm -rf "$work_dir"
  trap - EXIT
fi

python_root="$runtime_root/python-$python_version"
if [[ ! -x "$python_root/bin/python3" ]] || ! "$python_root/bin/python3" -c \
  "import sys; raise SystemExit(sys.version_info[:3] != tuple(map(int, '$python_version'.split('.'))))"; then
  for tool in gcc g++; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "ERROR: Python $python_version must be compiled, but $tool is unavailable." >&2
      exit 1
    fi
  done
  work_dir="$(mktemp -d)"
  trap 'rm -rf "$work_dir"' EXIT
  archive="Python-${python_version}.tar.xz"
  curl -fsSLo "$work_dir/$archive" "https://www.python.org/ftp/python/${python_version}/$archive"
  printf '%s  %s\n' "$python_sha256" "$work_dir/$archive" | sha256sum -c -
  mkdir -p "$work_dir/src"
  tar -xJf "$work_dir/$archive" -C "$work_dir/src" --strip-components=1
  (cd "$work_dir/src" && ./configure --prefix="$python_root" --enable-shared --with-ensurepip=install)
  make -C "$work_dir/src" -j"$(nproc)"
  rm -rf "$python_root"
  make -C "$work_dir/src" install
  rm -rf "$work_dir"
  trap - EXIT
fi

export PATH="$node_root/bin:$python_root/bin:$PATH"
export LD_LIBRARY_PATH="$python_root/lib:${LD_LIBRARY_PATH:-}"
[[ "$(node -p 'process.versions.node.split(`.`)[0]')" == '20' ]]
python3 -c "import sys; raise SystemExit(sys.version_info[:2] != (3, 12))"
npm --version
python3 -m pip --version
'@
  $provision = $provision.Replace('__NODE_VERSION__', $NodeVersion).Replace('__PYTHON_VERSION__', $PythonVersion).Replace('__PYTHON_SHA256__', $PythonSourceSha256)
  Invoke-Wsl $provision "Provision and validate Node.js $NodeVersion and Python $PythonVersion"

  $stage = @"
set -euo pipefail
rm -rf $quotedBuildRoot
mkdir -p $quotedBuildRoot
case $quotedBuildRoot in /mnt/*) echo 'ERROR: WSL build root must be on the Linux ext4 filesystem.' >&2; exit 1 ;; esac
rsync -a \
  --exclude='/.git/' \
  --exclude='/dist/' \
  --exclude='/backend/build/' \
  --exclude='/backend/dist/' \
  --exclude='/frontend/.cache/' \
  --exclude='/frontend/dist/' \
  --exclude='/frontend/dist-resources/' \
  --exclude='/frontend/node_modules/' \
  --exclude='/frontend/release/' \
  $quotedProjectRoot/ $quotedBuildRoot/
"@
  Invoke-Wsl $stage "Copy source into WSL ext4 build directory"

  $envParts = @("MODES=$(Quote-Bash $Modes)")
  if ($Archs) {
    $envParts += "ARCHES=$(Quote-Bash $Archs)"
  }
  if ($AllowNonDebian) {
    $envParts += "ALLOW_NON_DEBIAN=1"
  }
  $envPrefix = $envParts -join " "
  $nodeRoot = "/opt/official-document-ai-assistant-build/node-v$NodeVersion"
  $pythonRoot = "/opt/official-document-ai-assistant-build/python-$PythonVersion"
  $quotedBuildFrontend = Quote-Bash "$BuildRoot/frontend"

  Invoke-Wsl "export PATH='$nodeRoot/bin:$pythonRoot/bin':`$PATH; export LD_LIBRARY_PATH='$pythonRoot/lib':`${LD_LIBRARY_PATH:-}; cd $quotedBuildFrontend; $envPrefix bash scripts/build-debian-packages.sh" "Build Debian packages inside WSL ext4"
  Invoke-Wsl "mkdir -p $quotedFrontend/release; rsync -rt --no-perms --no-owner --no-group $quotedBuildFrontend/release/ $quotedFrontend/release/" "Copy Debian artifacts back to the Windows workspace"
}
finally {
  & wsl -d $Distro -u root -- bash -lc "rm -rf $quotedBuildRoot" 2>$null
}
