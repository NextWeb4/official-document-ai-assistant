"""Regression coverage for excluding local font binaries from packaged resources."""

from pathlib import Path

import build_backend


def test_windows_resource_copy_omits_local_ttf_directory(tmp_path: Path, monkeypatch) -> None:
    project_root = tmp_path / "project"
    dist_dir = project_root / "dist" / "backend_server"
    dist_dir.mkdir(parents=True)
    (dist_dir / "backend_server.exe").write_bytes(b"backend")
    for name in ("rules", "templates", "TTF", "data"):
        (project_root / name).mkdir()
    (project_root / "TTF" / "local-only.ttf").write_bytes(b"font")

    resources_dir = project_root / "frontend" / "dist-resources" / "backend"
    monkeypatch.setattr(build_backend, "PROJECT_ROOT", project_root)
    monkeypatch.setattr(build_backend, "DIST_DIR", dist_dir)
    monkeypatch.setattr(build_backend, "RESOURCES_DIR", resources_dir)
    monkeypatch.setattr(build_backend, "sync_installer_version", lambda: None)

    build_backend.copy_resources()

    assert (resources_dir / "backend_server" / "backend_server.exe").exists()
    assert (resources_dir / "rules").exists()
    assert (resources_dir / "templates").exists()
    assert not (resources_dir / "TTF").exists()
