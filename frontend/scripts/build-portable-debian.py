#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath


SCRIPT_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = SCRIPT_DIR.parent
PROJECT_ROOT = FRONTEND_DIR.parent
CACHE_DIR = FRONTEND_DIR / ".cache" / "portable-debian"
DOWNLOAD_DIR = CACHE_DIR / "downloads"
BUILD_DIR = CACHE_DIR / "build"
APP_ARCHIVE_DIR = CACHE_DIR / "app-asar"
RELEASE_DIR = FRONTEND_DIR / "release"
ASAR_CLI = FRONTEND_DIR / "node_modules" / "@electron" / "asar" / "bin" / "asar.js"
PYTHON_STANDALONE_RELEASE = "20260623"
ELECTRON_VERSION = "18.3.15"
DEBIAN_GLIBC_CEILING = (2, 28)
PORTABLE_ARCHES = ("x64", "arm64")
DEBIAN10_UNAVAILABLE_SONAMES = {
    "libcrypto.so.3",
    "libffi.so.8",
    "libssl.so.3",
}

# Electron 18.3.15 ELF requirements plus the desktop integration libraries used
# by electron-builder, named as they are packaged by Debian 10.
DEBIAN_DEPENDS = (
    "libasound2",
    "libatk-bridge2.0-0",
    "libatk1.0-0",
    "libatspi2.0-0",
    "libc6",
    "libcairo2",
    "libcups2",
    "libdbus-1-3",
    "libdrm2",
    "libexpat1",
    "libgbm1",
    "libgcc1 | libgcc-s1",
    "libglib2.0-0",
    "libgtk-3-0",
    "libnotify4",
    "libnspr4",
    "libnss3",
    "libpango-1.0-0",
    "libsecret-1-0",
    "libudev1",
    "libuuid1",
    "libx11-6",
    "libx11-xcb1",
    "libxcb1",
    "libxcomposite1",
    "libxdamage1",
    "libxext6",
    "libxfixes3",
    "libxkbcommon0",
    "libxrandr2",
    "libxshmfence1",
    "libxss1",
    "libxtst6",
    "xdg-utils",
)

ARCHES = {
    "x64": {
        "electron": "x64",
        "python_version": f"3.12.13+{PYTHON_STANDALONE_RELEASE}",
        "python": "x86_64-unknown-linux-gnu",
        "python_tag": "cp312",
        "python_lib": "python3.12",
        "pip_platform": "manylinux2014_x86_64",
        "deb_arch": "amd64",
        "elf_class": 2,
        "elf_machine": 62,
    },
    "arm64": {
        "electron": "arm64",
        "python_version": f"3.12.13+{PYTHON_STANDALONE_RELEASE}",
        "python": "aarch64-unknown-linux-gnu",
        "python_tag": "cp312",
        "python_lib": "python3.12",
        "pip_platform": "manylinux2014_aarch64",
        "deb_arch": "arm64",
        "elf_class": 2,
        "elf_machine": 183,
    },
    "armv7l": {
        "electron": "armv7l",
        "python_version": f"3.11.15+{PYTHON_STANDALONE_RELEASE}",
        "python": "armv7-unknown-linux-gnueabihf",
        "python_tag": "cp311",
        "python_lib": "python3.11",
        "pip_platform": "linux_armv7l",
        "extra_index_url": "https://www.piwheels.org/simple",
        "deb_arch": "armhf",
        "elf_class": 1,
        "elf_machine": 40,
    },
}

# GitHub's immutable 20260623 release asset digests.
PYTHON_ARCHIVE_SHA256 = {
    "x64": "10a452caac7041357805f0c19a60576df53f1ab06d1abfc9200f1f0157cb3bd1",
    "arm64": "b85154b9c7ca9de3f85f2c9f032d503151db16ef198de86b885fc61890c075ed",
    "armv7l": "331afe1a9ca4e4bb0570133135222654dbea616c28302a2d8612f846a94bb5c3",
}

# Electron v18.3.15 SHASUMS256.txt values.
ELECTRON_ARCHIVE_SHA256 = {
    "x64": "482101648dbf22e0e2c6be16cf36a9abf57028024abee56e23c143207d6ecdec",
    "arm64": "8fc93d852acc6722d6c4f62a74bc62d56abacb27c2b4ab644415b73e45c2e6b5",
    "armv7l": "2cc18781bdc5069878e544603fd66bccb9e8bf098f0250637cb5643cdc23d8bb",
}


def run(cmd: list[str], cwd: Path | None = None) -> None:
    print(">>>", " ".join(cmd))
    subprocess.run(cmd, cwd=cwd, check=True)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_valid_download(
    path: Path,
    expected_name: str | None = None,
    expected_sha256: str | None = None,
) -> bool:
    if not path.exists() or path.stat().st_size == 0:
        return False
    archive_name = (expected_name or path.name).lower()
    if archive_name.endswith(".zip"):
        archive_valid = zipfile.is_zipfile(path)
    elif archive_name.endswith((".tar.gz", ".tgz")):
        archive_valid = tarfile.is_tarfile(path)
    else:
        archive_valid = True
    if not archive_valid:
        return False
    return expected_sha256 is None or file_sha256(path) == expected_sha256.lower()


def download(url: str, dest: Path, expected_sha256: str | None = None) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if is_valid_download(dest, expected_sha256=expected_sha256):
        return
    if dest.exists():
        dest.unlink()
    partial = dest.with_name(f"{dest.name}.part")
    max_attempts = 12
    for attempt in range(1, max_attempts + 1):
        print(f"Downloading {url} (attempt {attempt}/{max_attempts})")
        try:
            resume_from = partial.stat().st_size if partial.exists() else 0
            headers = {"User-Agent": "HaoXiang-Document-Assistant-Debian-Builder/1.0"}
            if resume_from:
                headers["Range"] = f"bytes={resume_from}-"
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=120) as response:
                status = getattr(response, "status", None)
                if status is None:
                    getcode = getattr(response, "getcode", None)
                    status = getcode() if getcode else None
                append = resume_from > 0 and status == 206
                if resume_from and not append:
                    resume_from = 0
                with partial.open("ab" if append else "wb") as out:
                    shutil.copyfileobj(response, out)
                headers = getattr(response, "headers", None)
                content_length = headers.get("Content-Length") if headers else None
                content_range = headers.get("Content-Range") if headers else None
            expected_size = None
            if content_range and "/" in content_range:
                expected_size = int(content_range.rsplit("/", 1)[1])
            elif content_length:
                expected_size = resume_from + int(content_length)
            if expected_size and partial.stat().st_size != expected_size:
                raise OSError(
                    f"Incomplete download: got {partial.stat().st_size}, expected {expected_size} bytes"
                )
            if not is_valid_download(partial, dest.name, expected_sha256):
                partial.unlink()
                raise OSError(
                    f"Downloaded file failed archive or SHA-256 validation: {partial}"
                )
            partial.replace(dest)
            return
        except Exception:
            if attempt == max_attempts:
                raise
            time.sleep(2**attempt)


def copytree_filtered(src: Path, dst: Path) -> None:
    def ignore(_dir: str, names: list[str]) -> set[str]:
        return {
            name
            for name in names
            if name in {"__pycache__", ".pytest_cache", "build", "dist"}
            or name.endswith((".pyc", ".pyo"))
        }

    shutil.copytree(src, dst, ignore=ignore)


def make_requirements_linux(dest: Path) -> None:
    lines = []
    for line in (PROJECT_ROOT / "backend" / "requirements.txt").read_text(encoding="utf-8").splitlines():
        if line.strip().startswith("pywin32"):
            continue
        lines.append(line)
    # Keep Debian 10/QEMU-compatible wheels for python-docx's lxml dependency.
    lines.append("lxml==5.3.0")
    dest.write_text("\n".join(lines) + "\n", encoding="utf-8")


def download_wheels(arch: str, target: Path) -> None:
    req = CACHE_DIR / "requirements-linux.txt"
    make_requirements_linux(req)
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True, exist_ok=True)
    arch_config = ARCHES[arch]
    cmd = [
        sys.executable,
        "-m",
        "pip",
        "download",
        "-r",
        str(req),
        "--dest",
        str(target),
        "--only-binary=:all:",
        "--implementation",
        "cp",
        "--python-version",
        arch_config["python_tag"].removeprefix("cp"),
        "--abi",
        arch_config["python_tag"],
        "--platform",
        arch_config["pip_platform"],
    ]
    if "extra_index_url" in arch_config:
        cmd.extend(["--extra-index-url", arch_config["extra_index_url"]])
    run(cmd)


def wheel_cache_fingerprint(arch: str, requirements: str) -> str:
    config = ARCHES[arch]
    payload = {
        "arch": arch,
        "python_version": config["python_version"],
        "python_tag": config["python_tag"],
        "pip_platform": config["pip_platform"],
        "extra_index_url": config.get("extra_index_url"),
        "requirements": requirements,
    }
    return json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True) + "\n"


def glibc_versions(payload: bytes) -> set[tuple[int, ...]]:
    return {
        tuple(int(part) for part in match.groups() if part is not None)
        for match in re.finditer(rb"GLIBC_(\d+)\.(\d+)(?:\.(\d+))?", payload)
    }


def version_key(version: tuple[int, ...]) -> tuple[int, int, int]:
    return (version + (0, 0, 0))[:3]


def verify_wheel_set(arch: str, wheel_dir: Path) -> str:
    wheels = sorted(wheel_dir.glob("*.whl"))
    if not wheels:
        raise RuntimeError(f"No wheels found for {arch}: {wheel_dir}")

    bundled_sonames: set[str] = set()
    for wheel in wheels:
        with zipfile.ZipFile(wheel) as archive:
            for entry in archive.infolist():
                if entry.is_dir():
                    continue
                payload = archive.read(entry)
                if len(payload) >= 20 and payload[:4] == b"\x7fELF":
                    bundled_sonames.add(PurePosixPath(entry.filename).name)

    expected_class = ARCHES[arch]["elf_class"]
    expected_machine = ARCHES[arch]["elf_machine"]
    errors: list[str] = []
    highest_glibc: tuple[int, ...] | None = None
    native_files = 0

    for wheel in wheels:
        with zipfile.ZipFile(wheel) as archive:
            for entry in archive.infolist():
                if entry.is_dir():
                    continue
                payload = archive.read(entry)
                if len(payload) < 20 or payload[:4] != b"\x7fELF":
                    continue

                native_files += 1
                elf_class = payload[4]
                endian = payload[5]
                machine = int.from_bytes(payload[18:20], "little") if endian == 1 else -1
                label = f"{wheel.name}:{entry.filename}"
                if elf_class != expected_class or machine != expected_machine:
                    errors.append(
                        f"{label} has ELF class={elf_class} machine={machine}; "
                        f"expected class={expected_class} machine={expected_machine}"
                    )

                versions = glibc_versions(payload)
                if versions:
                    file_highest = max(versions, key=version_key)
                    highest_glibc = max(
                        highest_glibc or file_highest,
                        file_highest,
                        key=version_key,
                    )
                    if version_key(file_highest) > version_key(DEBIAN_GLIBC_CEILING):
                        version_text = ".".join(str(part) for part in file_highest)
                        errors.append(
                            f"{label} requires GLIBC_{version_text}, above Debian 10 GLIBC_2.28"
                        )

                for soname in sorted(DEBIAN10_UNAVAILABLE_SONAMES - bundled_sonames):
                    encoded = soname.encode("ascii")
                    if b"\0" + encoded + b"\0" in payload:
                        errors.append(
                            f"{label} requires {soname}, which Debian 10 does not provide and this wheel set does not bundle"
                        )

    if native_files == 0:
        raise RuntimeError(f"Wheel set has no native runtime components for {arch}: {wheel_dir}")
    if errors:
        details = "\n  - ".join(errors)
        raise RuntimeError(
            f"Wheel set is not compatible with Debian 10 {arch}:\n  - {details}"
        )

    highest_text = ".".join(str(part) for part in (highest_glibc or (0,)))
    return f"{native_files} native wheel files, max GLIBC_{highest_text}"


def extract_python(arch: str, resources: Path) -> None:
    archive_name = (
        f"cpython-{ARCHES[arch]['python_version']}-{ARCHES[arch]['python']}"
        "-install_only_stripped.tar.gz"
    )
    py_url = (
        "https://github.com/astral-sh/python-build-standalone/releases/download/"
        f"{PYTHON_STANDALONE_RELEASE}/{archive_name}"
    )
    py_tar = DOWNLOAD_DIR / archive_name
    download(py_url, py_tar, PYTHON_ARCHIVE_SHA256[arch])
    with tarfile.open(py_tar, "r:gz") as tf:
        for member in tf.getmembers():
            if member.name.startswith("python/share/terminfo/"):
                continue
            tf.extract(member, resources, filter="data")


def extract_wheels(wheel_dir: Path, resources: Path) -> None:
    arch = wheel_dir.name.removeprefix("wheels-")
    site_packages = resources / "python" / "lib" / ARCHES[arch]["python_lib"] / "site-packages"
    site_packages.mkdir(parents=True, exist_ok=True)
    for wheel in sorted(wheel_dir.glob("*.whl")):
        with zipfile.ZipFile(wheel) as zf:
            zf.extractall(site_packages)


def extract_electron(arch: str, app_dir: Path, executable_name: str) -> None:
    archive_name = (
        f"electron-v{ELECTRON_VERSION}-linux-{ARCHES[arch]['electron']}.zip"
    )
    electron_url = (
        f"https://github.com/electron/electron/releases/download/v{ELECTRON_VERSION}/"
        f"{archive_name}"
    )
    electron_zip = DOWNLOAD_DIR / f"electron-{ELECTRON_VERSION}-linux-{arch}.zip"
    download(electron_url, electron_zip, ELECTRON_ARCHIVE_SHA256[arch])
    with zipfile.ZipFile(electron_zip) as zf:
        zf.extractall(app_dir)
    electron_bin = app_dir / "electron"
    if electron_bin.exists():
        electron_bin.rename(app_dir / executable_name)


def prepare_frontend_archives(modes: list[str]) -> None:
    npm = shutil.which("npm.cmd" if sys.platform == "win32" else "npm")
    node = shutil.which("node")
    if not npm or not node:
        raise FileNotFoundError("Node.js and npm are required to build the frontend app archive")
    if not ASAR_CLI.exists():
        raise FileNotFoundError(f"Missing @electron/asar CLI; run npm install first: {ASAR_CLI}")

    run([npm, "run", "build"], cwd=FRONTEND_DIR)
    run([npm, "run", "electron:compile"], cwd=FRONTEND_DIR)

    package = json.loads((FRONTEND_DIR / "package.json").read_text(encoding="utf-8"))
    APP_ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    staging_root = CACHE_DIR / "app-source"
    if staging_root.exists():
        shutil.rmtree(staging_root)

    for mode in modes:
        staging = staging_root / mode
        copytree_filtered(FRONTEND_DIR / "dist", staging / "dist")
        copytree_filtered(FRONTEND_DIR / "electron" / "dist", staging / "electron" / "dist")
        runtime_package = {
            key: package[key]
            for key in (
                "name",
                "private",
                "version",
                "description",
                "license",
                "author",
                "homepage",
                "main",
            )
            if key in package
        }
        runtime_package["appMode"] = mode
        runtime_package["dependencies"] = {}
        (staging / "package.json").write_text(
            json.dumps(runtime_package, indent=2, ensure_ascii=True) + "\n",
            encoding="utf-8",
            newline="\n",
        )

        archive = APP_ARCHIVE_DIR / f"{mode}.asar"
        if archive.exists():
            archive.unlink()
        run([node, str(ASAR_CLI), "pack", str(staging), str(archive)])

    shutil.rmtree(staging_root)


def copy_runtime_resources(mode: str, resources: Path) -> None:
    app_asar = APP_ARCHIVE_DIR / f"{mode}.asar"
    if not app_asar.exists():
        raise FileNotFoundError(f"Missing generated app.asar: {app_asar}")
    shutil.copy2(app_asar, resources / "app.asar")
    for name in ["icon.png", "icon.ico"]:
        src = FRONTEND_DIR / "build" / name
        if src.exists():
            shutil.copy2(src, resources / name)

    copytree_filtered(PROJECT_ROOT / "backend", resources / "backend_src")
    copytree_filtered(PROJECT_ROOT / "rules", resources / "rules")
    copytree_filtered(PROJECT_ROOT / "templates", resources / "templates")
    (resources / "data").mkdir(parents=True, exist_ok=True)


def write_backend_launcher(resources: Path) -> None:
    python_lib = next((p.name for p in (resources / "python" / "lib").glob("python3.*")), "python3.12")
    launcher_dir = resources / "backend_server"
    launcher_dir.mkdir(parents=True, exist_ok=True)
    launcher = launcher_dir / "backend_server"
    launcher.write_text(
        f"""#!/usr/bin/env bash
set -euo pipefail
resources_dir="$(cd "$(dirname "$0")/.." && pwd)"
export LD_LIBRARY_PATH="$resources_dir/python/lib:${{LD_LIBRARY_PATH:-}}"
export PYTHONPATH="$resources_dir/backend_src:$resources_dir/python/lib/{python_lib}/site-packages:${{PYTHONPATH:-}}"
export PYTHONDONTWRITEBYTECODE=1
cd "$resources_dir"
exec "$resources_dir/python/bin/python3" "$resources_dir/backend_src/frozen_main.py" "$@"
""",
        encoding="utf-8",
        newline="\n",
    )


def write_desktop_files(root: Path, mode: str, product_name: str, executable_name: str) -> None:
    bin_dir = root / "usr" / "bin"
    app_dir = PurePosixPath("/opt") / product_name
    app_executable = app_dir / executable_name
    installed_launcher = PurePosixPath("/usr/bin") / executable_name
    bin_dir.mkdir(parents=True, exist_ok=True)
    (bin_dir / executable_name).write_text(
        f"""#!/usr/bin/env bash
app_path="{app_executable}"
state_home="${{XDG_STATE_HOME:-}}"
if [[ -z "$state_home" && -n "${{HOME:-}}" ]]; then
  state_home="$HOME/.local/state"
fi

if [[ -n "$state_home" ]]; then
  log_dir="$state_home/{product_name}"
  log_file="$log_dir/launcher.log"
  if (umask 077 && mkdir -p "$log_dir" && touch "$log_file") 2>/dev/null; then
    {{
      printf '\\n[%s] launching %s\\n' "$(date -Iseconds 2>/dev/null || date)" "$app_path"
      printf 'cwd=%s\\n' "$PWD"
      printf 'args='
      printf ' %q' "$@"
      printf '\\n'
    }} >>"$log_file" 2>&1
    exec "{app_executable}" --no-sandbox "$@" >>"$log_file" 2>&1
  fi
fi

exec "{app_executable}" --no-sandbox "$@"
""",
        encoding="utf-8",
        newline="\n",
    )

    desktop_dir = root / "usr" / "share" / "applications"
    desktop_dir.mkdir(parents=True, exist_ok=True)
    (desktop_dir / f"{executable_name}.desktop").write_text(
        f"""[Desktop Entry]
Name=HaoXiang Document Assistant {'Online' if mode == 'online' else 'Offline'}
TryExec={installed_launcher}
Exec={installed_launcher}
Icon=official-document-ai-assistant-{mode}
Type=Application
Terminal=false
StartupNotify=true
Categories=Office;
""",
        encoding="utf-8",
        newline="\n",
    )

    pixmaps = root / "usr" / "share" / "pixmaps"
    pixmaps.mkdir(parents=True, exist_ok=True)
    icon_src = PROJECT_ROOT / "frontend" / "build" / "icon.png"
    if icon_src.exists():
        shutil.copy2(icon_src, pixmaps / f"official-document-ai-assistant-{mode}.png")


def mode_for_path(path: str) -> int:
    executable_names = {
        "official-document-ai-assistant-offline",
        "official-document-ai-assistant-online",
        "backend_server",
        "chrome-sandbox",
        "chrome_crashpad_handler",
    }
    name = Path(path).name
    if path.startswith("./usr/bin/") or name in executable_names:
        return 0o755
    if "/resources/python/bin/" in path:
        return 0o755
    if path.endswith(".sh"):
        return 0o755
    return 0o644


def make_tar_gz(source: Path, dest: Path) -> None:
    with tarfile.open(dest, "w:gz", format=tarfile.GNU_FORMAT) as tf:
        for path in sorted(source.rglob("*")):
            arcname = "./" + path.relative_to(source).as_posix()
            info = tf.gettarinfo(str(path), arcname)
            if path.is_dir():
                info.mode = 0o755
                tf.addfile(info)
                continue
            info.mode = mode_for_path(arcname)
            with path.open("rb") as fh:
                tf.addfile(info, fh)


def make_control_tar(control_text: str, dest: Path) -> None:
    with tarfile.open(dest, "w:gz", format=tarfile.GNU_FORMAT) as tf:
        data = control_text.encode("utf-8")
        info = tarfile.TarInfo("./control")
        info.size = len(data)
        info.mode = 0o644
        info.mtime = int(time.time())
        tf.addfile(info, fileobj=__import__("io").BytesIO(data))


def write_ar(deb: Path, members: list[tuple[str, bytes]]) -> None:
    with deb.open("wb") as fh:
        fh.write(b"!<arch>\n")
        for name, data in members:
            encoded_name = (name + "/").encode("ascii")
            header = (
                encoded_name.ljust(16, b" ")
                + str(int(time.time())).encode("ascii").ljust(12, b" ")
                + b"0     "
                + b"0     "
                + b"100644  "
                + str(len(data)).encode("ascii").ljust(10, b" ")
                + b"`\n"
            )
            fh.write(header)
            fh.write(data)
            if len(data) % 2:
                fh.write(b"\n")


def installed_size(root: Path) -> int:
    total = sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
    return max(1, total // 1024)


def render_control(mode: str, arch: str, version: str, size_kib: int) -> str:
    depends = ", ".join(DEBIAN_DEPENDS)
    return f"""Package: official-document-ai-assistant-{mode}
Version: {version}
Section: office
Priority: optional
Architecture: {ARCHES[arch]['deb_arch']}
Maintainer: HaoXiang Huang <Rays688888@Gmail.com>
License: MIT
Installed-Size: {size_kib}
Depends: {depends}
Homepage: https://nextweb4.github.io/
Description: HaoXiang Document Assistant {mode}
 Desktop document checking and intelligent processing tool.
"""


def build_package(mode: str, arch: str) -> Path:
    if arch not in PORTABLE_ARCHES:
        raise RuntimeError(
            "Portable armv7l packaging is disabled: the available linux_armv7l "
            "cryptography/cffi wheel chain requires a newer glibc than Debian 10. "
            "Build armv7l on a matching Debian 10 builder and run verify:packages."
        )

    package = json.loads((FRONTEND_DIR / "package.json").read_text(encoding="utf-8"))
    version = package["version"]
    product_name = f"official-document-ai-assistant-{mode}"
    executable_name = product_name
    work = BUILD_DIR / f"{mode}-{arch}"
    if work.exists():
        shutil.rmtree(work)
    root = work / "root"
    app_root = root / "opt" / product_name
    resources = app_root / "resources"
    resources.mkdir(parents=True, exist_ok=True)

    extract_electron(arch, app_root, executable_name)
    extract_python(arch, resources)
    wheel_dir = CACHE_DIR / f"wheels-{arch}"
    req = CACHE_DIR / "requirements-linux.txt"
    make_requirements_linux(req)
    requirements = req.read_text(encoding="utf-8")
    fingerprint = wheel_cache_fingerprint(arch, requirements)
    marker = wheel_dir / ".wheel-set.json"
    legacy_marker = wheel_dir / ".requirements-linux.txt"
    cache_matches = (
        marker.exists() and marker.read_text(encoding="utf-8") == fingerprint
    ) or (
        not marker.exists()
        and legacy_marker.exists()
        and legacy_marker.read_text(encoding="utf-8") == requirements
    )
    if (
        not wheel_dir.exists()
        or not any(wheel_dir.glob("*.whl"))
        or not cache_matches
    ):
        download_wheels(arch, wheel_dir)
    wheel_summary = verify_wheel_set(arch, wheel_dir)
    marker.write_text(fingerprint, encoding="utf-8", newline="\n")
    print(f"Verified {arch} wheel set: {wheel_summary}")
    extract_wheels(wheel_dir, resources)
    copy_runtime_resources(mode, resources)
    write_backend_launcher(resources)
    write_desktop_files(root, mode, product_name, executable_name)

    control = render_control(mode, arch, version, installed_size(root))

    tmp = work / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    data_tar = tmp / "data.tar.gz"
    control_tar = tmp / "control.tar.gz"
    make_tar_gz(root, data_tar)
    make_control_tar(control, control_tar)

    out_dir = RELEASE_DIR / f"{mode}-debian"
    out_dir.mkdir(parents=True, exist_ok=True)
    deb = out_dir / f"official-document-ai-assistant-{mode}-{version}-{arch}.deb"
    write_ar(
        deb,
        [
            ("debian-binary", b"2.0\n"),
            ("control.tar.gz", control_tar.read_bytes()),
            ("data.tar.gz", data_tar.read_bytes()),
        ],
    )
    shutil.rmtree(work)
    return deb


def main() -> None:
    parser = argparse.ArgumentParser(description="Build portable Debian packages without Docker/WSL")
    parser.add_argument("--modes", default="offline,online")
    parser.add_argument(
        "--arch",
        default=",".join(PORTABLE_ARCHES),
        help="Portable Debian architectures: x64,arm64. Build armv7l on a matching Debian 10 builder.",
    )
    args = parser.parse_args()

    modes = [item.strip() for item in args.modes.split(",") if item.strip()]
    arches = [item.strip() for item in args.arch.split(",") if item.strip()]
    unsupported = [arch for arch in arches if arch not in ARCHES]
    if unsupported:
        raise SystemExit(f"Unsupported portable Debian arch: {', '.join(unsupported)}")
    unavailable = [arch for arch in arches if arch not in PORTABLE_ARCHES]
    if unavailable:
        raise SystemExit(
            "Portable Debian packaging is unavailable for "
            f"{', '.join(unavailable)}: current linux_armv7l cryptography/cffi wheels "
            "require GLIBC_2.34 and newer system libraries. Use a matching Debian 10 "
            "native/container builder, then run verify:packages before release."
        )
    unsupported_modes = [mode for mode in modes if mode not in {"offline", "online"}]
    if unsupported_modes:
        raise SystemExit(f"Unsupported mode: {', '.join(unsupported_modes)}")

    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    prepare_frontend_archives(modes)
    built: list[Path] = []
    for mode in modes:
        for arch in arches:
            deb = build_package(mode, arch)
            built.append(deb)
            print(f"Built {deb} ({deb.stat().st_size} bytes)")

    print("Built portable Debian packages:")
    for deb in built:
        print(f"  {deb}")


if __name__ == "__main__":
    main()
