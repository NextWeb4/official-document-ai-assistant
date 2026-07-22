# This file is part of the Official Document AI Assistant.
# (c) 2026 Jose AI (https://www.linhut.cn)
# Licensed under the MIT License. See the LICENSE file for details.
"""
Document CRUD API routes.
"""
import re
import shutil
import tempfile
from pathlib import Path

from fastapi import APIRouter, UploadFile, File, Depends, HTTPException
from sqlalchemy.orm import Session

from db.database import get_db
from api.schemas.api_models import DocumentUploadResponse, DocumentInfo
from services import document_service as svc
from config import TEMP_DIR
from utils.logger import logger
from core.document.converter import is_convertible, convert_to_docx
from core.document.models import RunFormat

router = APIRouter()


@router.post("/upload", response_model=DocumentUploadResponse)
async def upload_document(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Upload a .docx / .doc / .wps file."""
    filename = file.filename or "upload.docx"
    ext = Path(filename).suffix.lower()

    # 支持 .docx / .doc / .wps 三种格式
    if ext not in (".docx", ".doc", ".wps"):
        raise HTTPException(
            status_code=400,
            detail="仅支持 .docx、.doc、.wps 格式的文档"
        )

    # Check file size (max 10MB recommended, warn if larger)
    content = await file.read()
    file_size_mb = len(content) / (1024 * 1024)

    if file_size_mb > 50:
        raise HTTPException(
            status_code=400,
            detail="文件过大（超过 50MB）。建议使用 WPS/Word 插件处理大型文档。"
        )

    if file_size_mb > 10:
        logger.warning(f"Large file detected: {filename} ({file_size_mb:.2f} MB)")

    safe_name = re.sub(r'[^\w一-鿿._-]', '_', filename) or "upload.docx"
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix="upload-", dir=str(TEMP_DIR)))

    try:
        temp_path = temp_dir / safe_name
        temp_path.write_bytes(content)
        registered_filename = filename

        # .doc / .wps → 自动转换为 .docx
        if is_convertible(filename):
            try:
                converted_path = convert_to_docx(temp_path, temp_dir)
                logger.info(f"格式转换完成: {filename} → {converted_path.name}")
                temp_path = converted_path
                registered_filename = f"{Path(filename).stem}.docx"
            except RuntimeError as e:
                raise HTTPException(status_code=400, detail=str(e))
            except Exception as e:
                logger.error(f"文档转换失败: {e}")
                raise HTTPException(
                    status_code=500,
                    detail=f"文档格式转换失败: {str(e)}"
                )

        try:
            doc = svc.upload_document(db, temp_path, registered_filename)
        except svc.InvalidDocumentError as e:
            logger.warning(f"Invalid upload rejected: {filename}: {e}")
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            logger.error(f"Upload failed: {e}")
            raise HTTPException(status_code=500, detail=str(e))
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return DocumentUploadResponse(
        id=doc.id,
        filename=doc.filename,
        file_path=doc.file_path,
        document_type=doc.document_type,
        status=doc.status,
        page_count=doc.page_count,
        paragraph_count=doc.paragraph_count,
        created_at=doc.created_at,
    )


@router.get("/{doc_id}", response_model=DocumentInfo)
async def get_document(doc_id: int, db: Session = Depends(get_db)):
    """Get document info by ID."""
    doc = svc.get_document(db, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    return DocumentInfo(
        id=doc.id,
        filename=doc.filename,
        file_path=doc.file_path,
        file_hash=doc.file_hash,
        document_type=doc.document_type,
        status=doc.status,
        page_count=doc.page_count,
        paragraph_count=doc.paragraph_count,
        created_at=doc.created_at,
        updated_at=doc.updated_at,
    )


@router.get("/")
async def list_documents(skip: int = 0, limit: int = 50, db: Session = Depends(get_db)):
    """List all documents."""
    docs = svc.list_documents(db, skip, limit)
    return [
        DocumentInfo(
            id=d.id, filename=d.filename, file_path=d.file_path,
            file_hash=d.file_hash, document_type=d.document_type,
            status=d.status, page_count=d.page_count,
            paragraph_count=d.paragraph_count,
            created_at=d.created_at, updated_at=d.updated_at,
        )
        for d in docs
    ]


@router.delete("/{doc_id}")
async def delete_document(doc_id: int, db: Session = Depends(get_db)):
    """Delete a document record and owned generated files."""
    try:
        deleted = svc.delete_document(db, doc_id)
    except Exception as e:
        logger.error(f"Delete document failed: {e}")
        raise HTTPException(status_code=500, detail=f"删除文档失败: {str(e)}")
    if not deleted:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"success": True, "deleted_id": doc_id}


@router.post("/{doc_id}/validate")
async def validate_document(doc_id: int, db: Session = Depends(get_db)):
    """Validate document format quality (fonts, styles, layout, page setup)."""
    from core.document.validator import validate_document as run_validate

    doc = svc.get_document(db, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    try:
        result = run_validate(doc.file_path)
        return result.to_dict()
    except Exception as e:
        logger.error(f"Validation failed: {e}")
        raise HTTPException(status_code=500, detail=f"验证失败: {str(e)}")


@router.get("/{doc_id}/preview")
async def get_document_preview(doc_id: int, db: Session = Depends(get_db)):
    """Get document data for A4 preview rendering."""
    from core.document.parser import parse_docx

    doc = svc.get_document(db, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    try:
        file_path = svc.get_owned_optimized_output(doc)
    except svc.DocumentProcessingError as e:
        raise HTTPException(status_code=404, detail=str(e))

    try:
        model = parse_docx(str(file_path))
        paragraphs = []
        for p in model.paragraphs:
            font_name = None
            font_size_pt = None
            bold = None
            color = None
            try:
                if p.runs and p.runs[0].format:
                    font_name = getattr(p.runs[0].format, 'font_name', None)
                    font_size_pt = getattr(p.runs[0].format, 'font_size_pt', None)
                    bold = getattr(p.runs[0].format, 'bold', None)
                    color = getattr(p.runs[0].format, 'color', None)
            except Exception:
                pass

            # 每个 run 的独立格式（用于前端按 run 渲染加粗等）
            runs_data = []
            for r in p.runs:
                rf = r.format
                runs_data.append({
                    "text": r.text or "",
                    "bold": getattr(rf, 'bold', None),
                    "font_name": getattr(rf, 'font_name', None),
                })

            paragraphs.append({
                "text": p.text or "",
                "role": getattr(p, 'role', None),
                "is_heading": p.is_heading,
                "heading_level": p.heading_level,
                "format": {
                    "alignment": p.format.alignment,
                    "first_line_indent_pt": p.format.first_line_indent_pt,
                    "font_name": font_name,
                    "font_size_pt": font_size_pt,
                    "line_spacing_pt": p.format.line_spacing_pt,
                    "bold": bold,
                    "color": color,
                },
                "runs": runs_data,
            })
        # 序列化表格
        tables = []
        for t in model.tables:
            cells = []
            for c in t.cells:
                cell_paras = []
                for cp in c.paragraphs:
                    rf = cp.runs[0].format if cp.runs else RunFormat()
                    cell_paras.append({
                        "text": cp.text,
                        "format": {
                            "alignment": cp.format.alignment,
                            "font_name": getattr(rf, 'font_name', None),
                            "font_size_pt": getattr(rf, 'font_size_pt', None),
                            "bold": getattr(rf, 'bold', None),
                        },
                    })
                cells.append({"row": c.row, "col": c.col, "text": c.text, "paragraphs": cell_paras})
            tables.append({"index": t.index, "rows": t.rows, "cols": t.cols, "cells": cells, "insert_after_index": t.insert_after_index})

        return {
            "paragraphs": paragraphs,
            "tables": tables,
            "page_setup": {
                "margin_top_mm": model.page_setup.margin_top_mm if model.page_setup.margin_top_mm is not None else 37,
                "margin_bottom_mm": model.page_setup.margin_bottom_mm if model.page_setup.margin_bottom_mm is not None else 35,
                "margin_left_mm": model.page_setup.margin_left_mm if model.page_setup.margin_left_mm is not None else 28,
                "margin_right_mm": model.page_setup.margin_right_mm if model.page_setup.margin_right_mm is not None else 26,
            },
        }
    except Exception as e:
        logger.error(f"Preview generation failed: {e}")
        raise HTTPException(status_code=500, detail=f"预览生成失败: {str(e)}")
