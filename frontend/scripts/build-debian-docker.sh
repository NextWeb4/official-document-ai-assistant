#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

MODES="${MODES:-offline,online}"
ARCHES="${ARCHES:-x64,arm64}"
IMAGE_NAME="${IMAGE_NAME:-official-document-ai-assistant-debian10-builder}"
NODE_VERSION="${NODE_VERSION:-20.19.5}"
PYTHON_VERSION="${PYTHON_VERSION:-3.12.7}"
DRY_RUN="${DRY_RUN:-0}"

project_root="$(cd .. && pwd)"
dockerfile="$PWD/scripts/debian10-builder.Dockerfile"

docker_platform() {
  case "$1" in
    x64) echo "linux/amd64" ;;
    arm64) echo "linux/arm64" ;;
    armv7l) echo "linux/arm/v7" ;;
    *) echo "Unsupported architecture: $1" >&2; exit 1 ;;
  esac
}

run_step() {
  echo ">>> $*"
  if [[ "$DRY_RUN" != "1" ]]; then
    "$@"
  fi
}

if [[ ! -f "$dockerfile" ]]; then
  echo "ERROR: Dockerfile not found: $dockerfile" >&2
  exit 1
fi

if [[ "$DRY_RUN" != "1" ]] && ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is required for Debian 10.10 Docker packaging." >&2
  exit 1
fi

IFS=',' read -r -a arch_list <<< "$ARCHES"
for arch in "${arch_list[@]}"; do
  arch="$(echo "$arch" | xargs)"
  [[ -n "$arch" ]] || continue
  platform="$(docker_platform "$arch")"
  tag="${IMAGE_NAME}:${arch}"

  run_step docker buildx build \
    --platform "$platform" \
    --build-arg "NODE_VERSION=$NODE_VERSION" \
    --build-arg "PYTHON_VERSION=$PYTHON_VERSION" \
    --load \
    -t "$tag" \
    -f "$dockerfile" \
    "$project_root"

  container_script="$(cat <<EOF
set -euo pipefail
export PATH="/opt/node/bin:/opt/python/bin:\$PATH"
export LD_LIBRARY_PATH="/opt/python/lib:\${LD_LIBRARY_PATH:-}"
cd /
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
MODES=$MODES ARCHES=$arch bash scripts/build-debian-packages.sh
mkdir -p /workspace/frontend/release
cp -a release/*-debian /workspace/frontend/release/
EOF
)"

  run_step docker run --rm \
    --platform "$platform" \
    -v "$project_root:/workspace" \
    -e "MODES=$MODES" \
    -e "ARCHES=$arch" \
    "$tag" \
    bash -lc "$container_script"
done
