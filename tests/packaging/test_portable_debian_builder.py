from __future__ import annotations

import importlib.util
import hashlib
import io
from pathlib import Path, PureWindowsPath

import pytest


SCRIPT_PATH = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "scripts"
    / "build-portable-debian.py"
)
SPEC = importlib.util.spec_from_file_location("portable_debian_builder", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class FakeResponse(io.BytesIO):
    def __init__(self, payload: bytes, *, status: int, headers: dict[str, str]):
        super().__init__(payload)
        self.status = status
        self.headers = headers


def parse_control(text: str) -> dict[str, str]:
    fields = {}
    for line in text.splitlines():
        if line.startswith(" ") or ": " not in line:
            continue
        key, value = line.split(": ", 1)
        fields[key] = value
    return fields


def elf_fixture(
    *,
    elf_class: int = 2,
    machine: int = 62,
    strings: tuple[str, ...] = ("GLIBC_2.17",),
) -> bytes:
    payload = bytearray(64)
    payload[:6] = bytes((0x7F, 0x45, 0x4C, 0x46, elf_class, 1))
    payload[18:20] = machine.to_bytes(2, "little")
    return bytes(payload) + b"\0" + b"\0".join(
        value.encode("ascii") for value in strings
    ) + b"\0"


def write_wheel(path: Path, entries: dict[str, bytes]) -> None:
    with builder.zipfile.ZipFile(path, "w") as archive:
        for name, payload in entries.items():
            archive.writestr(name, payload)


def test_download_publishes_only_complete_file(tmp_path: Path, monkeypatch) -> None:
    payload = b"complete archive"
    monkeypatch.setattr(
        builder.urllib.request,
        "urlopen",
        lambda _request, timeout: FakeResponse(
            payload,
            status=200,
            headers={"Content-Length": str(len(payload))},
        ),
    )

    destination = tmp_path / "runtime.bin"
    builder.download("https://example.invalid/runtime.bin", destination)

    assert destination.read_bytes() == payload
    assert not (tmp_path / "runtime.bin.part").exists()


def test_download_retries_truncated_zip(tmp_path: Path, monkeypatch) -> None:
    valid_zip = io.BytesIO()
    with builder.zipfile.ZipFile(valid_zip, "w") as archive:
        archive.writestr("version", "18.3.15")
    payload = valid_zip.getvalue()
    split_at = len(payload) // 2
    responses = iter(
        (
            FakeResponse(
                payload[:split_at],
                status=200,
                headers={"Content-Length": str(len(payload))},
            ),
            FakeResponse(
                payload[split_at:],
                status=206,
                headers={
                    "Content-Length": str(len(payload) - split_at),
                    "Content-Range": f"bytes {split_at}-{len(payload) - 1}/{len(payload)}",
                },
            ),
        )
    )
    calls = []

    def fake_urlopen(request, timeout):
        calls.append((timeout, request.get_header("Range")))
        return next(responses)

    monkeypatch.setattr(builder.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(builder.time, "sleep", lambda _seconds: None)

    destination = tmp_path / "electron.zip"
    builder.download("https://example.invalid/electron.zip", destination)

    assert builder.zipfile.is_zipfile(destination)
    assert calls == [(120, None), (120, f"bytes={split_at}-")]


def test_download_replaces_valid_archive_with_wrong_sha256(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stale = io.BytesIO()
    with builder.zipfile.ZipFile(stale, "w") as archive:
        archive.writestr("version", "old")
    current = io.BytesIO()
    with builder.zipfile.ZipFile(current, "w") as archive:
        archive.writestr("version", "current")
    payload = current.getvalue()
    destination = tmp_path / "electron.zip"
    destination.write_bytes(stale.getvalue())
    calls = []

    def fake_urlopen(_request, timeout):
        calls.append(timeout)
        return FakeResponse(
            payload,
            status=200,
            headers={"Content-Length": str(len(payload))},
        )

    monkeypatch.setattr(builder.urllib.request, "urlopen", fake_urlopen)
    builder.download(
        "https://example.invalid/electron.zip",
        destination,
        hashlib.sha256(payload).hexdigest(),
    )

    assert destination.read_bytes() == payload
    assert calls == [120]


@pytest.mark.parametrize(
    ("mode", "label"),
    (("offline", "Offline"), ("online", "Online")),
)
def test_desktop_launcher_uses_posix_paths_and_persistent_logs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mode: str,
    label: str,
) -> None:
    product_name = f"official-document-ai-assistant-{mode}"

    # Simulate generation on Windows even when this test runs on Linux.
    monkeypatch.setattr(builder, "Path", PureWindowsPath)
    builder.write_desktop_files(tmp_path, mode, product_name, product_name)

    launcher = (tmp_path / "usr" / "bin" / product_name).read_text(encoding="utf-8")
    assert f'app_path="/opt/{product_name}/{product_name}"' in launcher
    assert "\\opt\\" not in launcher
    assert 'state_home="${XDG_STATE_HOME:-}"' in launcher
    assert 'state_home="$HOME/.local/state"' in launcher
    assert f'log_dir="$state_home/{product_name}"' in launcher
    assert 'log_file="$log_dir/launcher.log"' in launcher
    assert "printf '\\n[%s] launching %s\\n'" in launcher
    assert '>>"$log_file" 2>&1' in launcher
    expected_exec = f'exec "/opt/{product_name}/{product_name}" --no-sandbox "$@"'
    assert launcher.count(expected_exec) == 2

    desktop = (
        tmp_path / "usr" / "share" / "applications" / f"{product_name}.desktop"
    ).read_text(encoding="utf-8")
    assert f"Name=HaoXiang Document Assistant {label}" in desktop
    assert f"TryExec=/usr/bin/{product_name}" in desktop
    assert f"Exec=/usr/bin/{product_name}" in desktop
    assert "Terminal=false" in desktop
    assert "StartupNotify=true" in desktop
    assert "\\usr\\bin\\" not in desktop


def test_electron_runtime_is_pinned_for_debian_10() -> None:
    assert builder.ELECTRON_VERSION == "18.3.15"


def test_python_runtime_extraction_uses_tar_data_filter(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    download_dir = tmp_path / "downloads"
    download_dir.mkdir()
    archive_path = download_dir / (
        "cpython-3.12.13+20260623-x86_64-unknown-linux-gnu"
        "-install_only_stripped.tar.gz"
    )
    with builder.tarfile.open(archive_path, "w:gz") as archive:
        payload = b"python-runtime"
        info = builder.tarfile.TarInfo("python/bin/python3.12")
        info.size = len(payload)
        archive.addfile(info, io.BytesIO(payload))
        skipped = builder.tarfile.TarInfo("python/share/terminfo/x")
        skipped.size = 1
        archive.addfile(skipped, io.BytesIO(b"x"))

    monkeypatch.setattr(builder, "DOWNLOAD_DIR", download_dir)
    monkeypatch.setattr(
        builder,
        "download",
        lambda _url, _dest, _expected_sha256: None,
    )
    resources = tmp_path / "resources"
    resources.mkdir()

    builder.extract_python("x64", resources)

    assert (resources / "python" / "bin" / "python3.12").read_bytes() == b"python-runtime"
    assert not (resources / "python" / "share" / "terminfo" / "x").exists()
    assert builder.PYTHON_STANDALONE_RELEASE in archive_path.name
    assert 'filter="data"' in SCRIPT_PATH.read_text(encoding="utf-8")


def test_runtime_archive_cache_keys_and_hashes_are_pinned() -> None:
    source = SCRIPT_PATH.read_text(encoding="utf-8")

    assert "DOWNLOAD_DIR / archive_name" in source
    assert builder.PYTHON_ARCHIVE_SHA256 == {
        "x64": "10a452caac7041357805f0c19a60576df53f1ab06d1abfc9200f1f0157cb3bd1",
        "arm64": "b85154b9c7ca9de3f85f2c9f032d503151db16ef198de86b885fc61890c075ed",
        "armv7l": "331afe1a9ca4e4bb0570133135222654dbea616c28302a2d8612f846a94bb5c3",
    }
    assert builder.ELECTRON_ARCHIVE_SHA256["x64"] == (
        "482101648dbf22e0e2c6be16cf36a9abf57028024abee56e23c143207d6ecdec"
    )


def test_portable_architectures_exclude_unverified_armv7() -> None:
    assert builder.PORTABLE_ARCHES == ("x64", "arm64")
    with pytest.raises(RuntimeError, match="Portable armv7l packaging is disabled"):
        builder.build_package("offline", "armv7l")


def test_wheel_verifier_accepts_debian_10_native_components(tmp_path: Path) -> None:
    wheel = tmp_path / "runtime-1.0-cp312-cp312-manylinux2014_x86_64.whl"
    write_wheel(
        wheel,
        {"runtime/native.so": elf_fixture(strings=("GLIBC_2.17", "libc.so.6"))},
    )

    assert builder.verify_wheel_set("x64", tmp_path) == (
        "1 native wheel files, max GLIBC_2.17"
    )


def test_wheel_verifier_reports_all_armv7_compatibility_failures(tmp_path: Path) -> None:
    wheel = tmp_path / "runtime-1.0-cp311-cp311-linux_armv7l.whl"
    write_wheel(
        wheel,
        {
            "runtime/new-glibc.so": elf_fixture(
                elf_class=1,
                machine=40,
                strings=("GLIBC_2.34", "libssl.so.3"),
            ),
            "runtime/wrong-arch.so": elf_fixture(
                elf_class=2,
                machine=62,
                strings=("GLIBC_2.17",),
            ),
        },
    )

    with pytest.raises(RuntimeError) as exc_info:
        builder.verify_wheel_set("armv7l", tmp_path)

    message = str(exc_info.value)
    assert "requires GLIBC_2.34" in message
    assert "requires libssl.so.3" in message
    assert "expected class=1 machine=40" in message


def test_wheel_cache_fingerprint_tracks_platform_and_requirements() -> None:
    x64 = builder.wheel_cache_fingerprint("x64", "fastapi>=0.115\n")
    arm64 = builder.wheel_cache_fingerprint("arm64", "fastapi>=0.115\n")
    changed = builder.wheel_cache_fingerprint("x64", "fastapi>=0.116\n")

    assert x64 != arm64
    assert x64 != changed
    assert '"pip_platform": "manylinux2014_x86_64"' in x64


def test_runtime_resources_use_generated_app_archive(tmp_path: Path, monkeypatch) -> None:
    archive_dir = tmp_path / "archives"
    archive_dir.mkdir()
    (archive_dir / "offline.asar").write_bytes(b"current-app")
    frontend_dir = tmp_path / "frontend"
    (frontend_dir / "build").mkdir(parents=True)
    (frontend_dir / "build" / "icon.png").write_bytes(b"icon")

    project_root = tmp_path / "project"
    for name in ("backend", "rules", "templates"):
        (project_root / name).mkdir(parents=True)
    (project_root / "data").mkdir()
    (project_root / "data" / ".encryption_key").write_bytes(b"local-only-key")

    monkeypatch.setattr(builder, "APP_ARCHIVE_DIR", archive_dir)
    monkeypatch.setattr(builder, "FRONTEND_DIR", frontend_dir)
    monkeypatch.setattr(builder, "PROJECT_ROOT", project_root)

    resources = tmp_path / "resources"
    resources.mkdir()
    builder.copy_runtime_resources("offline", resources)

    assert (resources / "app.asar").read_bytes() == b"current-app"
    assert (resources / "icon.png").read_bytes() == b"icon"
    assert not (resources / "TTF").exists()
    assert not (resources / "data" / ".encryption_key").exists()
    assert "windows" not in builder.copy_runtime_resources.__code__.co_names


def test_debian_dependencies_cover_electron_18_runtime() -> None:
    required = {
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
        "libnspr4",
        "libnss3",
        "libpango-1.0-0",
        "libudev1",
        "libx11-6",
        "libxcb1",
        "libxcomposite1",
        "libxdamage1",
        "libxext6",
        "libxfixes3",
        "libxkbcommon0",
        "libxrandr2",
    }
    depends = set(builder.DEBIAN_DEPENDS)
    assert required <= depends
    assert len(builder.DEBIAN_DEPENDS) == len(depends)
    assert not any(dependency.startswith("libreoffice-") for dependency in depends)


@pytest.mark.parametrize("mode", ("offline", "online"))
@pytest.mark.parametrize(
    ("arch", "deb_arch"),
    (("x64", "amd64"), ("arm64", "arm64"), ("armv7l", "armhf")),
)
def test_control_metadata_for_all_modes_and_arches(
    mode: str,
    arch: str,
    deb_arch: str,
) -> None:
    fields = parse_control(builder.render_control(mode, arch, "1.2.3", 4096))

    assert fields["Package"] == f"official-document-ai-assistant-{mode}"
    assert fields["Version"] == "1.2.3"
    assert fields["Architecture"] == deb_arch
    assert fields["Installed-Size"] == "4096"
    assert fields["Homepage"] == "https://nextweb4.github.io/"
    assert fields["Maintainer"] == "HaoXiang Huang <Rays688888@Gmail.com>"
    assert fields["Depends"].split(", ") == list(builder.DEBIAN_DEPENDS)
    assert not any(
        dependency.startswith("libreoffice-")
        for dependency in fields["Depends"].split(", ")
    )
    assert "Suggests" not in fields
    assert "Recommends" not in fields
