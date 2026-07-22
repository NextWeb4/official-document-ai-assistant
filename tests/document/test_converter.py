from __future__ import annotations

import sys

import pytest

from core.document import converter


def test_missing_linux_converter_recommends_writer_package(tmp_path, monkeypatch):
    source = tmp_path / "legacy.doc"
    source.write_bytes(b"legacy")

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(converter, "_try_libreoffice", lambda *_args: False)

    with pytest.raises(RuntimeError) as exc_info:
        converter.convert_to_docx(source, tmp_path / "output")

    message = str(exc_info.value)
    assert "libreoffice-writer" in message
    assert "libreoffice-common" not in message
