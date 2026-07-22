from datetime import datetime
from io import BytesIO
from pathlib import Path
import re
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.datastructures import UploadFile
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from api.routes import check as check_routes
from api.routes import documents as document_routes
from api.routes import optimize as optimize_routes
from api.schemas.api_models import IssueActionRequest
from core.document.models import DocumentModel, PageSetup
from db.database import Base
from db.models import CheckResult, Document
from services import document_service as svc


def _session():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(bind=engine)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)()


def _document_response(filename: str = "upload.docx") -> SimpleNamespace:
    return SimpleNamespace(
        id=1,
        filename=filename,
        file_path=f"/uploads/{filename}",
        document_type="notice",
        status="uploaded",
        page_count=1,
        paragraph_count=1,
        created_at=datetime.now(),
    )


@pytest.mark.asyncio
async def test_converted_uploads_use_isolated_directories_and_cleanup(tmp_path, monkeypatch):
    temp_root = tmp_path / "temp"
    conversion_dirs: list[Path] = []

    def fake_convert(source: Path, output_dir: Path) -> Path:
        assert source.parent == output_dir
        conversion_dirs.append(output_dir)
        converted = output_dir / f"{source.stem}.docx"
        converted.write_bytes(b"converted")
        (output_dir / "converter-sidecar.tmp").write_bytes(b"sidecar")
        return converted

    def fake_upload(_db, file_path: Path, filename: str):
        assert file_path.exists()
        assert filename == "same.docx"
        return _document_response("same.docx")

    monkeypatch.setattr(document_routes, "TEMP_DIR", temp_root)
    monkeypatch.setattr(document_routes, "convert_to_docx", fake_convert)
    monkeypatch.setattr(document_routes.svc, "upload_document", fake_upload)

    for _ in range(2):
        upload = UploadFile(BytesIO(b"legacy"), filename="same.doc")
        await document_routes.upload_document(upload, db=object())

    assert len(conversion_dirs) == 2
    assert conversion_dirs[0] != conversion_dirs[1]
    assert all(not directory.exists() for directory in conversion_dirs)
    assert list(temp_root.iterdir()) == []


@pytest.mark.asyncio
async def test_upload_cleanup_runs_when_conversion_fails(tmp_path, monkeypatch):
    temp_root = tmp_path / "temp"
    conversion_dir: Path | None = None

    def fail_conversion(_source: Path, output_dir: Path) -> Path:
        nonlocal conversion_dir
        conversion_dir = output_dir
        (output_dir / "partial.docx").write_bytes(b"partial")
        raise RuntimeError("converter unavailable")

    monkeypatch.setattr(document_routes, "TEMP_DIR", temp_root)
    monkeypatch.setattr(document_routes, "convert_to_docx", fail_conversion)

    upload = UploadFile(BytesIO(b"legacy"), filename="same.wps")
    with pytest.raises(HTTPException) as exc_info:
        await document_routes.upload_document(upload, db=object())

    assert exc_info.value.status_code == 400
    assert conversion_dir is not None
    assert not conversion_dir.exists()
    assert list(temp_root.iterdir()) == []


@pytest.mark.asyncio
async def test_invalid_docx_upload_returns_400_and_leaves_no_registered_file(tmp_path, monkeypatch):
    temp_root = tmp_path / "temp"
    upload_root = tmp_path / "uploads"
    upload_root.mkdir()
    db = _session()
    monkeypatch.setattr(document_routes, "TEMP_DIR", temp_root)
    monkeypatch.setattr(svc, "UPLOAD_DIR", upload_root)

    upload = UploadFile(BytesIO(b"not-a-docx"), filename="broken.docx")
    with pytest.raises(HTTPException) as exc_info:
        await document_routes.upload_document(upload, db=db)

    assert exc_info.value.status_code == 400
    assert list(upload_root.iterdir()) == []
    assert db.query(Document).count() == 0


def test_upload_commit_failure_rolls_back_and_removes_copied_file(tmp_path, monkeypatch):
    class FailingSession:
        rolled_back = False

        def add(self, _document):
            return None

        def commit(self):
            raise RuntimeError("database unavailable")

        def rollback(self):
            self.rolled_back = True

        def refresh(self, _document):
            raise AssertionError("refresh must not run after failed commit")

    source = tmp_path / "source.docx"
    source.write_bytes(b"valid-enough-for-mocked-parser")
    upload_root = tmp_path / "uploads"
    upload_root.mkdir()
    db = FailingSession()
    monkeypatch.setattr(svc, "UPLOAD_DIR", upload_root)
    monkeypatch.setattr(svc, "parse_docx", lambda _path: DocumentModel())

    with pytest.raises(RuntimeError, match="database unavailable"):
        svc.upload_document(db, source, "source.docx")

    assert db.rolled_back is True
    assert list(upload_root.iterdir()) == []


def test_upload_refresh_failure_keeps_file_owned_by_committed_row(tmp_path, monkeypatch):
    class RefreshFailingSession:
        rolled_back = False
        committed = False

        def add(self, _document):
            return None

        def commit(self):
            self.committed = True

        def rollback(self):
            self.rolled_back = True

        def refresh(self, _document):
            raise RuntimeError("refresh unavailable")

    source = tmp_path / "source.docx"
    source.write_bytes(b"valid-enough-for-mocked-parser")
    upload_root = tmp_path / "uploads"
    upload_root.mkdir()
    db = RefreshFailingSession()
    monkeypatch.setattr(svc, "UPLOAD_DIR", upload_root)
    monkeypatch.setattr(svc, "parse_docx", lambda _path: DocumentModel())

    with pytest.raises(RuntimeError, match="refresh unavailable"):
        svc.upload_document(db, source, "source.docx")

    assert db.committed is True
    assert db.rolled_back is True
    assert [path.name for path in upload_root.iterdir()] == ["source.docx"]


@pytest.mark.asyncio
async def test_upload_passes_normalized_fallback_filename(tmp_path, monkeypatch):
    temp_root = tmp_path / "temp"
    upload_dir: Path | None = None

    def fake_upload(_db, file_path: Path, filename: str):
        nonlocal upload_dir
        upload_dir = file_path.parent
        assert file_path.name == "upload.docx"
        assert filename == "upload.docx"
        return _document_response()

    monkeypatch.setattr(document_routes, "TEMP_DIR", temp_root)
    monkeypatch.setattr(document_routes.svc, "upload_document", fake_upload)

    upload = UploadFile(BytesIO(b"docx"), filename=None)
    await document_routes.upload_document(upload, db=object())

    assert upload_dir is not None
    assert not upload_dir.exists()


@pytest.mark.asyncio
async def test_rule_engine_failure_preserves_results_and_maps_to_500(tmp_path, monkeypatch):
    db = _session()
    source = tmp_path / "source.docx"
    source.write_bytes(b"docx")
    document = Document(
        filename="source.docx",
        file_path=str(source),
        file_hash="hash",
        document_type="notice",
        status="optimized",
    )
    db.add(document)
    db.commit()
    db.refresh(document)

    existing = CheckResult(
        document_id=document.id,
        check_type="format",
        severity="P1",
        rule_id="existing",
        status="accepted",
    )
    db.add(existing)
    db.commit()
    existing_id = existing.id

    monkeypatch.setattr(svc, "parse_docx", lambda _path: object())

    def fail_check(*_args, **_kwargs):
        raise RuntimeError("broken rule set")

    monkeypatch.setattr(svc._rule_engine, "check", fail_check)

    with pytest.raises(HTTPException) as exc_info:
        await check_routes.run_check(document.id, None, db)

    assert exc_info.value.status_code == 500
    assert "规则引擎检查失败" in exc_info.value.detail
    db.expire_all()
    assert db.query(Document).filter(Document.id == document.id).one().status == "optimized"
    preserved = db.query(CheckResult).filter(CheckResult.id == existing_id).one()
    assert preserved.status == "accepted"
    assert preserved.rule_id == "existing"


@pytest.mark.asyncio
async def test_missing_document_check_maps_to_404():
    db = _session()

    with pytest.raises(HTTPException) as exc_info:
        await check_routes.run_check(999, None, db)

    assert exc_info.value.status_code == 404


@pytest.mark.asyncio
async def test_issue_update_is_scoped_to_document():
    db = _session()
    first = Document(filename="first.docx", file_path="first.docx", file_hash="first")
    second = Document(filename="second.docx", file_path="second.docx", file_hash="second")
    db.add_all([first, second])
    db.commit()
    issue = CheckResult(
        document_id=second.id,
        check_type="format",
        severity="P1",
        status="pending",
    )
    db.add(issue)
    db.commit()
    issue_id = issue.id

    with pytest.raises(HTTPException) as exc_info:
        await check_routes.update_issue(
            first.id,
            issue_id,
            IssueActionRequest(action="accept"),
            db,
        )

    assert exc_info.value.status_code == 404
    db.expire_all()
    assert db.query(CheckResult).filter(CheckResult.id == issue_id).one().status == "pending"

    result = await check_routes.update_issue(
        second.id,
        issue_id,
        IssueActionRequest(action="accept"),
        db,
    )
    assert result == {"status": "accepted"}


def test_export_filenames_are_collision_resistant():
    names = {svc.export_filename("原始文件.docx", "optimized") for _ in range(100)}

    assert len(names) == 100
    assert all(
        re.fullmatch(
            r"原始文件_optimized_\d{8}_\d{6}_\d{6}_[0-9a-f]{8}\.docx",
            name,
        )
        for name in names
    )


def test_committing_new_optimized_output_removes_superseded_owned_file(tmp_path, monkeypatch):
    db = _session()
    output_dir = tmp_path / "outputs"
    output_dir.mkdir()
    previous = output_dir / "previous.docx"
    current = output_dir / "current.docx"
    previous.write_bytes(b"old")
    current.write_bytes(b"new")
    document = Document(
        filename="source.docx",
        file_path=str(tmp_path / "source.docx"),
        file_hash="replace-output",
        optimized_path=str(previous),
        status="optimized",
    )
    db.add(document)
    db.commit()
    monkeypatch.setattr(svc, "OUTPUT_DIR", output_dir)

    svc.commit_optimized_output(db, document, current)

    db.refresh(document)
    assert document.optimized_path == str(current)
    assert current.read_bytes() == b"new"
    assert not previous.exists()


def test_superseded_output_is_kept_while_another_document_references_it(tmp_path, monkeypatch):
    db = _session()
    output_dir = tmp_path / "outputs"
    output_dir.mkdir()
    shared = output_dir / "shared.docx"
    current = output_dir / "current.docx"
    shared.write_bytes(b"shared")
    current.write_bytes(b"new")
    first = Document(
        filename="first.docx", file_path="first.docx", file_hash="first-output",
        optimized_path=str(shared), status="optimized",
    )
    second = Document(
        filename="second.docx", file_path="second.docx", file_hash="second-output",
        optimized_path=str(shared), status="optimized",
    )
    db.add_all([first, second])
    db.commit()
    monkeypatch.setattr(svc, "OUTPUT_DIR", output_dir)

    svc.commit_optimized_output(db, first, current)

    assert shared.exists()
    assert second.optimized_path == str(shared)


def test_optimize_reports_successful_fix_handlers_not_issue_count(tmp_path, monkeypatch):
    class FakeRuleEngine:
        def check_and_fix_with_count(self, model, _doc_type, _selected):
            return [object(), object(), object()], model, 1

        def check(self, _model, _doc_type):
            return []

    db = _session()
    source = tmp_path / "source.docx"
    source.write_bytes(b"source")
    output_dir = tmp_path / "outputs"
    output_dir.mkdir()
    document = Document(
        filename="source.docx",
        file_path=str(source),
        file_hash="count-fixes",
        status="checked",
    )
    db.add(document)
    db.commit()
    monkeypatch.setattr(svc, "OUTPUT_DIR", output_dir)
    monkeypatch.setattr(svc, "parse_docx", lambda _path: DocumentModel())
    monkeypatch.setattr(svc, "_rule_engine", FakeRuleEngine())
    monkeypatch.setattr(
        svc,
        "generate_docx",
        lambda _model, path: Path(path).write_bytes(b"generated"),
    )

    result = svc.optimize_document(db, document.id, selected_rule_ids=["CHK-001"])

    assert result["fixes_applied"] == 1
    assert Path(result["output_path"]).exists()


@pytest.mark.asyncio
async def test_optimize_uses_typed_error_mapping(monkeypatch):
    cases = [
        (svc.DocumentNotFoundError("missing"), 404),
        (svc.InvalidDocumentError("invalid"), 422),
        (svc.DocumentProcessingError("engine failed"), 500),
    ]

    for error, expected_status in cases:
        def fail(*_args, _error=error, **_kwargs):
            raise _error

        monkeypatch.setattr(optimize_routes.svc, "optimize_document", fail)
        with pytest.raises(HTTPException) as exc_info:
            await optimize_routes.run_optimize(1, db=object())
        assert exc_info.value.status_code == expected_status
        assert exc_info.value.detail == str(error)


@pytest.mark.asyncio
async def test_preview_preserves_zero_margins_and_defaults_only_none(tmp_path, monkeypatch):
    source = tmp_path / "source.docx"
    source.write_bytes(b"docx")
    stored = SimpleNamespace(id=1, optimized_path=str(source), file_path=str(source))
    model = DocumentModel(
        page_setup=PageSetup(
            margin_top_mm=0,
            margin_bottom_mm=None,
            margin_left_mm=0,
            margin_right_mm=None,
        )
    )

    monkeypatch.setattr(document_routes.svc, "get_document", lambda _db, _id: stored)
    monkeypatch.setattr(document_routes.svc, "OUTPUT_DIR", tmp_path)
    import core.document.parser as parser_module

    monkeypatch.setattr(parser_module, "parse_docx", lambda _path: model)

    preview = await document_routes.get_document_preview(1, db=object())

    assert preview["page_setup"] == {
        "margin_top_mm": 0,
        "margin_bottom_mm": 35,
        "margin_left_mm": 0,
        "margin_right_mm": 26,
    }
