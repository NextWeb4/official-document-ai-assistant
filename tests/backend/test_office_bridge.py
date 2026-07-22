import base64

import pytest
from fastapi import HTTPException

from api.routes import office


def test_decode_to_temp_keeps_file_inside_bridge_tmp(tmp_path, monkeypatch):
    monkeypatch.setattr(office, "_BRIDGE_TMP", tmp_path)
    payload = base64.b64encode(b"docx-bytes").decode("utf-8")

    out = office._decode_to_temp(payload, "../unsafe name.docx")

    assert out.parent == tmp_path
    assert out.name == "unsafe_name.docx"
    assert out.read_bytes() == b"docx-bytes"


def test_decode_to_temp_rejects_non_docx_extension(tmp_path, monkeypatch):
    monkeypatch.setattr(office, "_BRIDGE_TMP", tmp_path)
    payload = base64.b64encode(b"data").decode("utf-8")

    with pytest.raises(HTTPException) as exc:
        office._decode_to_temp(payload, "payload.exe")

    assert exc.value.status_code == 400
    assert not any(tmp_path.iterdir())


def test_decode_to_temp_rejects_invalid_base64(tmp_path, monkeypatch):
    monkeypatch.setattr(office, "_BRIDGE_TMP", tmp_path)

    with pytest.raises(HTTPException) as exc:
        office._decode_to_temp("not base64!", "payload.docx")

    assert exc.value.status_code == 400
    assert not any(tmp_path.iterdir())
