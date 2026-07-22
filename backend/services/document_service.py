# This file is part of the Official Document AI Assistant.
# (c) 2026 Jose AI (https://www.linhut.cn)
# Licensed under the MIT License. See the LICENSE file for details.
"""
Document service: business logic for document upload, check, optimize operations.
"""
from __future__ import annotations
import re
import shutil
from datetime import datetime
from pathlib import Path
from uuid import uuid4
from sqlalchemy.orm import Session

from config import UPLOAD_DIR, OUTPUT_DIR
from db.models import Document, CheckResult
from core.document.parser import parse_docx
from core.document.generator import generate_docx
from core.rules.engine import RuleEngine
from utils.file_utils import file_sha256
from utils.logger import logger

_rule_engine = RuleEngine()


class DocumentNotFoundError(LookupError):
    """Raised when a requested document record does not exist."""


class DocumentProcessingError(RuntimeError):
    """Raised when an existing document cannot be processed safely."""


class InvalidDocumentError(ValueError):
    """Raised when an uploaded Office document cannot be parsed."""


class DocumentDeletionError(DocumentProcessingError):
    """Raised when owned files prevent an atomic document deletion."""


def clear_rule_cache() -> None:
    """清除规则引擎缓存，供外部模块调用。"""
    _rule_engine.clear_cache()

# 输出文件名后缀
_OPTIMIZED_SUFFIX = "_optimized.docx"

# 文件名→文档类型映射（基于关键词）
_TYPE_KEYWORDS: dict[str, str] = {
    "命令": "command", "令": "command",
    "决定": "decision",
    "公告": "notice_public",
    "通告": "announcement",
    "通知": "notice",
    "通报": "bulletin",
    "议案": "bill",
    "报告": "report",
    "请示": "request",
    "批复": "reply",
    "函": "letter",
    "纪要": "minutes", "会议纪要": "meeting",
    "决议": "resolution",
    "指示": "instruction",
    "制度": "regulation",
    "公报": "communique",
    "意见": "opinion",
    "总结": "summary",
    "方案": "work_plan", "计划": "work_plan",
    "桌签": "table_sign",
    "技术方案": "technical_proposal",
}


def _detect_doc_type(filename: str) -> str:
    """根据文件名关键词推断文档类型，无法识别时返回 'notice'。"""
    stem = Path(filename).stem
    # 按关键词长度降序匹配（"会议纪要" 优先于 "纪要"，"技术方案" 优先于 "方案"）
    for keyword in sorted(_TYPE_KEYWORDS, key=len, reverse=True):
        if keyword in stem:
            return _TYPE_KEYWORDS[keyword]
    return "notice"


def _safe_filename(filename: str) -> str:
    """安全处理文件名，防止路径遍历。保留中文字符。"""
    # 取最后一个路径分隔符之后的部分
    name = Path(filename).name
    # 移除危险字符，保留中文、字母、数字、下划线、点、连字符
    safe = re.sub(r'[^\w一-鿿._-]', '_', name)
    return safe or "upload.docx"


def _unique_path(directory: Path, filename: str) -> Path:
    candidate = directory / filename
    if not candidate.exists():
        return candidate
    stem = candidate.stem
    suffix = candidate.suffix
    counter = 1
    while True:
        next_path = directory / f"{stem}_{counter}{suffix}"
        if not next_path.exists():
            return next_path
        counter += 1


def _path_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def export_filename(filename: str, suffix: str = "") -> str:
    stem = Path(filename or "公文").stem
    safe_stem = re.sub(r'[<>:"/\\|?*]+', "_", stem).strip(" .")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    nonce = uuid4().hex[:8]
    suffix_part = f"_{suffix}" if suffix else ""
    return f"{safe_stem or '公文'}{suffix_part}_{timestamp}_{nonce}.docx"


def upload_document(db: Session, file_path: Path, filename: str) -> Document:
    """Upload and register a document in the database."""
    safe_name = _safe_filename(filename)
    dest = _unique_path(UPLOAD_DIR, safe_name)

    if not file_path.exists():
        raise FileNotFoundError(f"上传文件不存在: {file_path}")

    shutil.copy2(str(file_path), str(dest))

    try:
        doc_hash = file_sha256(dest)
        model = parse_docx(str(dest))
        paragraph_count = len(model.paragraphs)
    except Exception as e:
        try:
            dest.unlink(missing_ok=True)
        except OSError as cleanup_error:
            logger.warning(f"Failed to clean invalid upload {dest}: {cleanup_error}")
        raise InvalidDocumentError(f"文档解析失败，请确认文件内容有效: {str(e)}") from e

    doc = Document(
        filename=safe_name,
        file_path=str(dest),
        file_hash=doc_hash,
        document_type=_detect_doc_type(filename),
        status="uploaded",
        page_count=1,
        paragraph_count=paragraph_count,
    )
    db.add(doc)
    try:
        db.commit()
    except Exception:
        db.rollback()
        try:
            dest.unlink(missing_ok=True)
        except OSError as cleanup_error:
            logger.warning(f"Failed to clean unregistered upload {dest}: {cleanup_error}")
        raise

    try:
        db.refresh(doc)
    except Exception:
        # The row and its file are already committed. Rolling back the current
        # transaction is safe, but deleting the file would orphan that row.
        db.rollback()
        logger.exception(f"Failed to refresh committed document {safe_name}")
        raise
    logger.info(f"Document uploaded: {doc.id} - {safe_name}")
    return doc


def get_document(db: Session, doc_id: int) -> Document | None:
    return db.query(Document).filter(Document.id == doc_id).first()


def list_documents(db: Session, skip: int = 0, limit: int = 50) -> list[Document]:
    return db.query(Document).order_by(Document.created_at.desc()).offset(skip).limit(limit).all()


def delete_document(db: Session, doc_id: int) -> bool:
    doc = get_document(db, doc_id)
    if not doc:
        return False

    candidate_paths = list(dict.fromkeys(p for p in (doc.file_path, doc.optimized_path) if p))
    removable_paths: list[tuple[str, Path]] = []
    for raw_path in candidate_paths:
        path = Path(raw_path)
        if not (_path_within(path, UPLOAD_DIR) or _path_within(path, OUTPUT_DIR)):
            logger.warning(f"Skip deleting unmanaged document path: {path}")
            continue
        shared = db.query(Document).filter(
            Document.id != doc_id,
            (Document.file_path == raw_path) | (Document.optimized_path == raw_path),
        ).first()
        if not shared:
            removable_paths.append((raw_path, path))

    staged_paths: list[tuple[str, Path, Path]] = []
    try:
        for raw_path, path in removable_paths:
            if not path.exists():
                continue
            staged = path.with_name(f".{path.name}.{uuid4().hex}.deleting")
            path.replace(staged)
            staged_paths.append((raw_path, path, staged))
    except Exception as exc:
        for _raw_path, original, staged in reversed(staged_paths):
            try:
                if staged.exists() and not original.exists():
                    staged.replace(original)
            except Exception as restore_exc:
                logger.error(f"Failed to restore staged document file {staged}: {restore_exc}")
        raise DocumentDeletionError(f"文档文件正在使用或无法删除: {path}") from exc

    if staged_paths:
        staged_by_raw = {raw: str(staged) for raw, _original, staged in staged_paths}
        if doc.file_path in staged_by_raw:
            doc.file_path = staged_by_raw[doc.file_path]
        if doc.optimized_path in staged_by_raw:
            doc.optimized_path = staged_by_raw[doc.optimized_path]
        try:
            # Persist temporary ownership before removing any file. If unlinking
            # fails, the document row remains retryable and still owns the file.
            db.commit()
        except Exception:
            db.rollback()
            for _raw_path, original, staged in reversed(staged_paths):
                try:
                    if staged.exists() and not original.exists():
                        staged.replace(original)
                except Exception as restore_exc:
                    logger.error(f"Failed to restore staged document file {staged}: {restore_exc}")
            raise

    cleanup_failures: list[str] = []
    for _raw_path, _original, staged in staged_paths:
        try:
            staged.unlink(missing_ok=True)
        except Exception as exc:
            cleanup_failures.append(f"{staged}: {exc}")

    if cleanup_failures:
        raise DocumentDeletionError("文档文件删除失败，请关闭占用该文件的程序后重试")

    try:
        db.delete(doc)
        db.commit()
    except Exception:
        db.rollback()
        raise

    logger.info(f"Document deleted: {doc_id}")
    return True


def remove_unreferenced_output(db: Session, raw_path: str | Path | None) -> None:
    """Remove an owned output only after no document record references it."""
    if not raw_path:
        return
    path = Path(raw_path)
    if not _path_within(path, OUTPUT_DIR):
        logger.warning(f"Skip deleting unmanaged output path: {path}")
        return
    referenced = db.query(Document).filter(
        (Document.file_path == str(raw_path)) | (Document.optimized_path == str(raw_path)),
    ).first()
    if referenced:
        return
    try:
        if path.exists():
            path.unlink()
    except Exception as exc:
        logger.warning(f"Failed to remove superseded output {path}: {exc}")


def _replace_check_results(db: Session, doc_id: int, issues: list) -> tuple[int, int, int]:
    """Replace one document's check rows inside the caller's transaction."""
    db.query(CheckResult).filter(CheckResult.document_id == doc_id).delete()
    p0 = p1 = p2 = 0
    for issue in issues:
        if issue.severity == "P0":
            p0 += 1
        elif issue.severity == "P1":
            p1 += 1
        else:
            p2 += 1
        db.add(CheckResult(
            document_id=doc_id,
            check_type=issue.check_type,
            severity=issue.severity,
            rule_id=issue.rule_id,
            location=issue.location,
            original_text=issue.original_text,
            suggested_fix=issue.suggested_fix,
            reason=issue.reason,
        ))
    return p0, p1, p2


def commit_optimized_output(
    db: Session,
    doc: Document,
    output_path: str | Path,
    *,
    check_issues: list | None = None,
    document_type: str | None = None,
) -> None:
    """Persist an optimized output and optional post-optimization check state."""
    new_path = str(Path(output_path))
    previous_path = doc.optimized_path
    try:
        doc.status = "optimized"
        doc.optimized_path = new_path
        if document_type:
            doc.document_type = document_type
        if check_issues is not None:
            _replace_check_results(db, doc.id, check_issues)
        db.commit()
    except Exception:
        db.rollback()
        remove_unreferenced_output(db, new_path)
        raise

    if previous_path and previous_path != new_path:
        remove_unreferenced_output(db, previous_path)


def _existing_owned_optimized_path(doc: Document) -> Path | None:
    """Return only the exact existing output path recorded for this document."""
    if not doc.optimized_path:
        return None

    path = Path(doc.optimized_path)
    if not _path_within(path, OUTPUT_DIR):
        logger.warning(f"Ignore unmanaged optimized path for document {doc.id}: {path}")
        return None
    if not path.is_file():
        return None
    return path


def get_current_document_source(doc: Document) -> Path:
    """Resolve the latest valid source without guessing an output filename."""
    optimized_path = _existing_owned_optimized_path(doc)
    if optimized_path is not None:
        return optimized_path

    source_path = Path(doc.file_path)
    if not source_path.is_file():
        raise DocumentProcessingError(f"Document file not found: {source_path}")
    return source_path


def get_owned_optimized_output(doc: Document) -> Path:
    """Require this document's explicit, managed, existing optimized output."""
    path = _existing_owned_optimized_path(doc)
    if path is None:
        raise DocumentProcessingError("Optimized file not found. Run optimize first.")
    return path


def check_document(db: Session, doc_id: int, doc_type: str | None = None) -> dict:
    """Run rule-based checks on a document. Saves results to DB."""
    doc = get_document(db, doc_id)
    if not doc:
        raise DocumentNotFoundError(f"Document not found: {doc_id}")

    doc_type = doc_type or doc.document_type or "notice"

    try:
        source_path = get_current_document_source(doc)
        model = parse_docx(str(source_path))
    except Exception as e:
        logger.error(f"parse_docx failed for doc {doc_id}: {e}")
        raise DocumentProcessingError(
            f"文档解析失败，请确认文件格式正确（.docx/.doc/.wps）: {str(e)}"
        ) from e

    # Rule-based checks using RuleEngine
    try:
        issues = _rule_engine.check(model, doc_type)
    except Exception as e:
        logger.error(f"RuleEngine.check failed for doc {doc_id}, type={doc_type}: {e}")
        raise DocumentProcessingError(f"规则引擎检查失败: {str(e)}") from e

    # Save to DB（带 rollback 保护）
    try:
        p0, p1, p2 = _replace_check_results(db, doc_id, issues)
        doc.document_type = doc_type
        doc.status = "optimized" if _existing_owned_optimized_path(doc) else "checked"
        db.commit()
    except Exception as e:
        logger.error(f"Failed to save check results for doc {doc_id}: {e}")
        db.rollback()
        raise DocumentProcessingError(f"检查结果保存失败: {str(e)}") from e

    logger.info(f"Check complete: {len(issues)} issues found (P0:{p0}, P1:{p1}, P2:{p2})")

    return {
        "document_id": doc_id,
        "total_issues": len(issues),
        "p0_count": p0,
        "p1_count": p1,
        "p2_count": p2,
    }


def get_check_results(db: Session, doc_id: int) -> list[CheckResult]:
    return db.query(CheckResult).filter(CheckResult.document_id == doc_id).all()


def update_issue_status(db: Session, doc_id: int, issue_id: int, status: str) -> bool:
    issue = db.query(CheckResult).filter(
        CheckResult.document_id == doc_id,
        CheckResult.id == issue_id,
    ).first()
    if not issue:
        return False
    issue.status = status
    db.commit()
    return True


def optimize_document(
    db: Session, doc_id: int, doc_type: str | None = None, apply_fixes: bool = True,
    selected_rule_ids: list[str] | None = None,
) -> dict:
    """Check + fix a document, then generate the optimized docx."""
    doc = get_document(db, doc_id)
    if not doc:
        raise DocumentNotFoundError(f"Document not found: {doc_id}")

    doc_type = doc_type or doc.document_type or "notice"

    # 解析文档
    try:
        source_path = get_current_document_source(doc)
        model = parse_docx(str(source_path))
    except Exception as e:
        logger.error(f"parse_docx failed for doc {doc_id} during optimize: {e}")
        raise InvalidDocumentError(
            f"文档解析失败，请确认文件格式正确（.docx/.doc/.wps）: {str(e)}"
        ) from e

    # 规则检查 + 修复
    try:
        if apply_fixes:
            _issues_before_fix, fixed_model, fixes_applied = _rule_engine.check_and_fix_with_count(
                model, doc_type, selected_rule_ids
            )
        else:
            fixed_model = model
            fixes_applied = 0
    except Exception as e:
        logger.error(f"RuleEngine failed for doc {doc_id}, type={doc_type}: {e}")
        raise DocumentProcessingError(f"规则引擎处理失败: {str(e)}") from e

    # Recheck the fixed in-memory model before committing any new output. The
    # stored issue rows must describe the document that will be downloaded.
    try:
        remaining_issues = _rule_engine.check(fixed_model, doc_type)
    except Exception as e:
        logger.error(f"Post-fix check failed for doc {doc_id}, type={doc_type}: {e}")
        raise DocumentProcessingError(f"优化结果复核失败: {str(e)}") from e

    # 生成优化后的文档
    out_name = export_filename(doc.filename, "optimized")
    out_path = OUTPUT_DIR / out_name
    try:
        generate_docx(fixed_model, str(out_path))
    except Exception as e:
        remove_unreferenced_output(db, out_path)
        logger.error(f"generate_docx failed for doc {doc_id}: {e}")
        raise DocumentProcessingError(f"文档生成失败: {str(e)}") from e

    # 更新数据库（带 rollback 保护）
    try:
        commit_optimized_output(
            db,
            doc,
            out_path,
            check_issues=remaining_issues,
            document_type=doc_type,
        )
    except Exception as e:
        logger.error(f"Failed to update doc {doc_id} status: {e}")
        raise

    logger.info(
        f"Document optimized: {doc_id} -> {out_path} "
        f"(applied {fixes_applied} fixes, {len(remaining_issues)} issues remain)"
    )
    return {
        "document_id": doc_id,
        "output_path": str(out_path),
        "output_name": out_name,
        "fixes_applied": fixes_applied,
    }
