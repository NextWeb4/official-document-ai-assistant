param(
  [string]$Modes = "offline,online",
  [string]$Archs = "x64,arm64",
  [string]$ImageName = "official-document-ai-assistant-debian10-builder",
  [string]$NodeVersion = "20.19.5",
  [string]$PythonVersion = "3.12.7",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$FrontendDir = Resolve-Path (Join-Path $ScriptDir "..")
$ProjectRoot = Resolve-Path (Join-Path $FrontendDir "..")
$Dockerfile = Join-Path $ScriptDir "debian10-builder.Dockerfile"

function Get-DockerPlatform([string]$Arch) {
  switch ($Arch) {
    "x64" { return "linux/amd64" }
    "arm64" { return "linux/arm64" }
    "armv7l" { return "linux/arm/v7" }
    default { throw "Unsupported architecture: $Arch" }
  }
}

function Invoke-Step([string]$Title, [string[]]$Command) {
  Write-Host ">>> $Title"
  Write-Host ($Command -join " ")
  if (-not $DryRun) {
    $exe = $Command[0]
    $args = $Command[1..($Command.Length - 1)]
    & $exe @args
    if ($LASTEXITCODE -ne 0) {
      throw "Command failed ($LASTEXITCODE): $($Command -join ' ')"
    }
  }
}

if (-not (Test-Path -LiteralPath $Dockerfile)) {
  throw "Dockerfile not found: $Dockerfile"
}

if (-not $DryRun) {
  $docker = Get-Command docker -ErrorAction SilentlyContinue
  if (-not $docker) {
    throw "Docker is required for Debian 10.10 Docker packaging, but docker was not found."
  }
}

$archList = $Archs.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ }
$mountRoot = $ProjectRoot.Path

foreach ($arch in $archList) {
  $platform = Get-DockerPlatform $arch
  $tag = "${ImageName}:${arch}"

  Invoke-Step "Build Debian 10.10 builder image for $arch" @(
    "docker", "buildx", "build",
    "--platform", $platform,
    "--build-arg", "NODE_VERSION=$NodeVersion",
    "--build-arg", "PYTHON_VERSION=$PythonVersion",
    "--load",
    "-t", $tag,
    "-f", $Dockerfile,
    $ProjectRoot.Path
  )

  $containerScript = @"
set -euo pipefail
rm -rf /build/work
mkdir -p /build/work
rsync -a --delete \
  --exclude .git \
  --exclude frontend/node_modules \
  --exclude frontend/release \
  --exclude frontend/dist \
  --exclude frontend/dist-resources \
  --exclude dist \
  --exclude backend/build \
  /workspace/ /build/work/
cd /build/work/frontend
MODES=$Modes ARCHES=$arch bash scripts/build-debian-packages.sh
mkdir -p /workspace/frontend/release
cp -a release/*-debian /workspace/frontend/release/
"@

  Invoke-Step "Build Debian packages for $arch" @(
    "docker", "run", "--rm",
    "--platform", $platform,
    "-v", "${mountRoot}:/workspace",
    "-e", "MODES=$Modes",
    "-e", "ARCHES=$arch",
    $tag,
    "bash", "-lc", $containerScript
  )
}
