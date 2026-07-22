import asyncio
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from api.routes import templates as template_routes


def _configure_template_storage(tmp_path, monkeypatch):
    template_dir = tmp_path / "uploaded_templates"
    template_dir.mkdir()
    index_path = template_dir / "index.json"
    monkeypatch.setattr(template_routes, "_UPLOADED_TEMPLATE_FILES_DIR", template_dir)
    monkeypatch.setattr(template_routes, "_UPLOADED_TEMPLATE_FILES_INDEX", index_path)
    return template_dir, index_path


def test_atomic_json_replace_failure_preserves_previous_metadata(tmp_path, monkeypatch):
    path = tmp_path / "index.json"
    path.write_text('{"stable": true}\n', encoding="utf-8")

    def fail_replace(_source, _target):
        raise OSError("replace failed")

    monkeypatch.setattr(template_routes.os, "replace", fail_replace)

    with pytest.raises(OSError, match="replace failed"):
        template_routes._atomic_write_json(path, {"stable": False})

    assert json.loads(path.read_text(encoding="utf-8")) == {"stable": True}
    assert list(tmp_path.glob(".index.json.*.tmp")) == []


def test_uploaded_template_unlink_failure_restores_file_and_index(tmp_path, monkeypatch):
    template_dir, index_path = _configure_template_storage(tmp_path, monkeypatch)
    template_id = "tpl_test"
    stored_filename = f"{template_id}.docx"
    template_path = template_dir / stored_filename
    template_path.write_bytes(b"template")
    record = {
        "id": template_id,
        "name": "test",
        "original_filename": "test.docx",
        "stored_filename": stored_filename,
    }
    template_routes._save_template_file_index({template_id: record})

    original_unlink = Path.unlink

    def fail_staged_unlink(self, *args, **kwargs):
        if self.name.endswith(".deleting"):
            raise OSError("file in use")
        return original_unlink(self, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", fail_staged_unlink)

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(template_routes.delete_uploaded_template_file(template_id))

    assert exc_info.value.status_code == 500
    assert template_path.read_bytes() == b"template"
    assert template_routes._load_template_file_index()[template_id] == record
    assert json.loads(index_path.read_text(encoding="utf-8"))[template_id] == record
