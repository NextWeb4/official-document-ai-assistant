from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from core.document.models import DocumentModel
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


def _issue(rule_id: str, reason: str = "格式不符合规则"):
    return SimpleNamespace(
        check_type="format",
        severity="P1",
        rule_id=rule_id,
        location="正文第1段",
        original_text="原文",
        suggested_fix="修复格式",
        reason=reason,
    )


def _add_document(db, source: Path, *, document_type: str = "notice") -> Document:
    document = Document(
        filename=source.name,
        file_path=str(source),
        file_hash=f"hash-{source.name}",
        document_type=document_type,
        status="uploaded",
    )
    db.add(document)
    db.commit()
    db.refresh(document)
    return document


def test_check_persists_explicit_document_type_even_with_zero_issues(tmp_path, monkeypatch):
    db = _session()
    source = tmp_path / "generic.docx"
    source.write_bytes(b"source")
    document = _add_document(db, source)
    seen_types: list[str] = []

    class FakeRuleEngine:
        def check(self, _model, document_type):
            seen_types.append(document_type)
            return []

    monkeypatch.setattr(svc, "parse_docx", lambda _path: DocumentModel())
    monkeypatch.setattr(svc, "_rule_engine", FakeRuleEngine())

    result = svc.check_document(db, document.id, "report")

    db.refresh(document)
    assert seen_types == ["report"]
    assert result["total_issues"] == 0
    assert document.document_type == "report"
    assert document.status == "checked"
    assert db.query(CheckResult).filter(CheckResult.document_id == document.id).count() == 0


def test_optimize_persists_selected_type_and_post_fix_recheck(tmp_path, monkeypatch):
    db = _session()
    source = tmp_path / "generic.docx"
    source.write_bytes(b"source")
    output_dir = tmp_path / "outputs"
    output_dir.mkdir()
    document = _add_document(db, source)
    db.add(CheckResult(
        document_id=document.id,
        check_type="format",
        severity="P0",
        rule_id="STALE",
        reason="旧结果",
    ))
    db.commit()
    selected_calls: list[tuple[str, ...]] = []
    checked_types: list[str] = []

    class FakeRuleEngine:
        def check_and_fix_with_count(self, model, document_type, selected_rule_ids):
            assert document_type == "report"
            selected_calls.append(tuple(selected_rule_ids or []))
            return [_issue("CHK-001")], model, 1

        def check(self, _model, document_type):
            checked_types.append(document_type)
            return [_issue("CHK-REMAINING", "修复后仍存在")]

    monkeypatch.setattr(svc, "OUTPUT_DIR", output_dir)
    monkeypatch.setattr(svc, "parse_docx", lambda _path: DocumentModel())
    monkeypatch.setattr(svc, "_rule_engine", FakeRuleEngine())
    monkeypatch.setattr(
        svc,
        "generate_docx",
        lambda _model, path: Path(path).write_bytes(b"generated"),
    )

    result = svc.optimize_document(
        db,
        document.id,
        doc_type="report",
        selected_rule_ids=["CHK-001"],
    )

    db.refresh(document)
    stored_results = db.query(CheckResult).filter(CheckResult.document_id == document.id).all()
    assert selected_calls == [("CHK-001",)]
    assert checked_types == ["report"]
    assert result["fixes_applied"] == 1
    assert document.document_type == "report"
    assert document.status == "optimized"
    assert document.optimized_path == result["output_path"]
    assert Path(result["output_path"]).read_bytes() == b"generated"
    assert [(row.rule_id, row.reason) for row in stored_results] == [
        ("CHK-REMAINING", "修复后仍存在"),
    ]
