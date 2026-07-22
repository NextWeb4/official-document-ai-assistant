# This file is part of the Official Document AI Assistant.
# (c) 2026 Jose AI (https://www.linhut.cn)
# Licensed under the MIT License. See the LICENSE file for details.
"""
Optimize API routes: auto-fix and document generation.
"""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from sqlalchemy.orm import Session
from pathlib import Path
import os
from datetime import datetime
from urllib.parse import quote

from db.database import get_db
from api.schemas.api_models import OptimizeRequest, OptimizeResponse
from services import document_service as svc

router = APIRouter()


# ---------------------------------------------------------------------------
#  Markdown 格式转换（前端实时预览用）— 必须在 /{doc_id} 之前定义
# ---------------------------------------------------------------------------

from pydantic import BaseModel, Field
from typing import Any


class ParagraphData(BaseModel):
    text: str
    role: str | None = None
    is_heading: bool = False
    heading_level: int | None = None
    format: dict[str, Any] = Field(default_factory=dict)


class MarkdownConvertRequest(BaseModel):
    paragraphs: list[ParagraphData]


@router.post("/convert-markdown")
async def convert_markdown_text(body: MarkdownConvertRequest):
    """对段落文本执行 Markdown 格式识别与转换，返回转换后的段落。"""
    from core.document.models import (
        DocumentModel, DocumentMetadata, PageSetup,
        Paragraph, ParagraphFormat, Run, RunFormat,
    )
    from core.document.modifier import convert_markdown

    model = DocumentModel(
        metadata=DocumentMetadata(), page_setup=PageSetup(),
        paragraphs=[], tables=[], headers=[], footers=[],
    )

    for i, p in enumerate(body.paragraphs):
        rf = RunFormat(font_name=p.format.get('font_name'), font_size_pt=p.format.get('font_size_pt'), bold=p.format.get('bold'))
        pf = ParagraphFormat(alignment=p.format.get('alignment'), first_line_indent_pt=p.format.get('first_line_indent_pt'), line_spacing_pt=p.format.get('line_spacing_pt'))
        model.paragraphs.append(Paragraph(index=i, text=p.text, is_heading=p.is_heading, heading_level=p.heading_level, role=p.role, runs=[Run(index=0, text=p.text, format=rf)], format=pf))

    changes = convert_markdown(model)

    result = []
    for p in model.paragraphs:
        rf = p.runs[0].format if p.runs else RunFormat()
        result.append({
            "text": p.text, "role": p.role, "is_heading": p.is_heading, "heading_level": p.heading_level,
            "format": {"alignment": p.format.alignment, "first_line_indent_pt": p.format.first_line_indent_pt, "font_name": rf.font_name, "font_size_pt": rf.font_size_pt, "line_spacing_pt": p.format.line_spacing_pt, "bold": rf.bold},
        })

    # 序列化表格（markdown 表格转换后生成的 Table 对象）
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
                        "font_name": rf.font_name,
                        "font_size_pt": rf.font_size_pt,
                        "bold": rf.bold,
                    },
                })
            cells.append({"row": c.row, "col": c.col, "text": c.text, "paragraphs": cell_paras})
        tables.append({"index": t.index, "rows": t.rows, "cols": t.cols, "cells": cells, "insert_after_index": t.insert_after_index})

    return {"success": True, "changes": changes, "paragraphs": result, "tables": tables}


# ---------------------------------------------------------------------------
#  从预览数据生成 docx 并下载
# ---------------------------------------------------------------------------

class PreviewDownloadRequest(BaseModel):
    paragraphs: list[ParagraphData]
    tables: list[dict] | None = None
    page_setup: dict | None = None
    format_config: dict[str, Any] | None = None
    source_filename: str | None = None


_DEFAULT_PREVIEW_FORMAT_CONFIG: dict[str, Any] = {
    "title": {"fontFamily": "方正小标宋简体", "fontSize": 22, "bold": False, "align": "center"},
    "heading1": {"fontFamily": "黑体", "fontSize": 16, "bold": False, "indent": 2},
    "heading2": {"fontFamily": "楷体_GB2312", "fontSize": 16, "bold": False, "indent": 0},
    "heading3": {"fontFamily": "仿宋_GB2312", "fontSize": 16, "bold": True, "indent": 0},
    "body": {
        "fontFamily": "仿宋_GB2312",
        "asciiFontFamily": "Times New Roman",
        "fontSize": 16,
        "lineSpacing": 28.95,
        "firstLineIndent": 2,
        "align": "justify",
    },
    "header": {"enabled": False, "orgName": "", "docNumber": "", "signer": ""},
    "footerNote": {"enabled": False, "cc": "", "printer": "", "printDate": ""},
    "pageNumber": {"show": True, "format": "dash"},
}


def _deep_merge_dict(base: dict[str, Any], overlay: dict[str, Any] | None) -> dict[str, Any]:
    """Merge user preview config onto backend defaults without mutating either input."""
    import copy

    result = copy.deepcopy(base)
    if not overlay:
        return result
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _deep_merge_dict(result[key], value)
        elif value is not None:
            result[key] = value
    return result


def _num(value: Any, fallback: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _bool(value: Any, fallback: bool = False) -> bool:
    return fallback if value is None else bool(value)


def _download_filename(source_filename: str, suffix: str = "") -> str:
    stem = Path(source_filename or "公文").stem
    safe_stem = "".join(ch if ch not in '<>:"/\\|?*' else "_" for ch in stem).strip(" .")
    timestamp = datetime.now().strftime("%Y%m%d_%H%M")
    suffix_part = f"_{suffix}" if suffix else ""
    return f"{safe_stem or '公文'}{suffix_part}_{timestamp}.docx"


def _file_response(path: str | Path, filename: str, *, background: BackgroundTask | None = None) -> FileResponse:
    encoded = quote(filename)
    response = FileResponse(
        path=str(path),
        filename=filename,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        background=background,
    )
    response.headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{encoded}"
    return response


def _style_key_for_paragraph(p: ParagraphData) -> str:
    if p.role == "title" or (p.is_heading and p.heading_level == 0):
        return "title"
    if p.is_heading and p.heading_level == 1:
        return "heading1"
    if p.is_heading and p.heading_level == 2:
        return "heading2"
    if p.is_heading and p.heading_level == 3:
        return "heading3"
    return "body"


def _formats_from_preview_config(
    p: ParagraphData,
    config: dict[str, Any] | None,
    *,
    style_key: str | None = None,
    force_text_color: str | None = None,
    force_align: str | None = None,
    force_indent_pt: float | None = None,
) -> tuple["RunFormat", "ParagraphFormat"]:
    """Return run/paragraph formats, applying live preview settings when provided."""
    from core.document.models import ParagraphFormat, RunFormat

    raw_fmt = p.format or {}
    if not config:
        rf = RunFormat(
            font_name=raw_fmt.get("font_name"),
            latin_font_name=raw_fmt.get("latin_font_name") or raw_fmt.get("ascii_font_name"),
            font_size_pt=raw_fmt.get("font_size_pt"),
            bold=raw_fmt.get("bold"),
            color=raw_fmt.get("color"),
        )
        pf = ParagraphFormat(
            alignment=raw_fmt.get("alignment"),
            first_line_indent_pt=raw_fmt.get("first_line_indent_pt"),
            line_spacing_pt=raw_fmt.get("line_spacing_pt"),
        )
        return rf, pf

    cfg = _deep_merge_dict(_DEFAULT_PREVIEW_FORMAT_CONFIG, config)
    body = cfg["body"]
    latin_font_name = body.get("asciiFontFamily") or "Times New Roman"
    key = style_key or _style_key_for_paragraph(p)
    line_spacing = _num(body.get("lineSpacing"), 28.95)
    alignment = force_align
    first_line_indent_pt = force_indent_pt
    font_name = body.get("fontFamily", "仿宋_GB2312")
    font_size = _num(body.get("fontSize"), 16)
    bold = raw_fmt.get("bold")
    color = force_text_color or raw_fmt.get("color")

    if key == "title":
        title = cfg["title"]
        font_name = title.get("fontFamily", "方正小标宋简体")
        font_size = _num(title.get("fontSize"), 22)
        bold = _bool(title.get("bold"), False)
        alignment = alignment or title.get("align", "center")
        first_line_indent_pt = 0 if first_line_indent_pt is None else first_line_indent_pt
    elif key in ("heading1", "heading2", "heading3"):
        heading = cfg[key]
        font_name = heading.get("fontFamily", font_name)
        font_size = _num(heading.get("fontSize"), font_size)
        bold = _bool(heading.get("bold"), False)
        alignment = alignment or raw_fmt.get("alignment") or "left"
        if first_line_indent_pt is None:
            first_line_indent_pt = _num(heading.get("indent"), 0) * font_size
    elif key == "table_header":
        font_name = "黑体"
        font_size = max(_num(body.get("fontSize"), 16) - 2, 12)
        bold = True
        alignment = alignment or "center"
        first_line_indent_pt = 0 if first_line_indent_pt is None else first_line_indent_pt
    else:
        alignment = alignment or body.get("align", "justify")
        if first_line_indent_pt is None:
            first_line_indent_pt = _num(body.get("firstLineIndent"), 2) * font_size

    rf = RunFormat(
        font_name=font_name,
        latin_font_name=latin_font_name,
        font_size_pt=font_size,
        bold=bold,
        color=color,
    )
    pf = ParagraphFormat(
        alignment=alignment,
        first_line_indent_pt=first_line_indent_pt,
        line_spacing_pt=line_spacing,
        line_spacing_rule="exact",
    )
    return rf, pf


def _make_preview_paragraph(
    *,
    index: int,
    text: str,
    config: dict[str, Any] | None,
    style_key: str = "body",
    role: str | None = None,
    is_heading: bool = False,
    heading_level: int | None = None,
    color: str | None = None,
    align: str | None = None,
    indent_pt: float | None = None,
) -> "Paragraph":
    from core.document.models import Paragraph, Run

    data = ParagraphData(text=text, role=role, is_heading=is_heading, heading_level=heading_level)
    rf, pf = _formats_from_preview_config(
        data,
        config,
        style_key=style_key,
        force_text_color=color,
        force_align=align,
        force_indent_pt=indent_pt,
    )
    return Paragraph(
        index=index,
        text=text,
        role=role,
        is_heading=is_heading,
        heading_level=heading_level,
        runs=[Run(index=0, text=text, format=rf)],
        format=pf,
    )


def _append_configured_header(model: "DocumentModel", config: dict[str, Any] | None) -> None:
    if not config:
        return
    cfg = _deep_merge_dict(_DEFAULT_PREVIEW_FORMAT_CONFIG, config)
    header = cfg.get("header", {})
    if not header.get("enabled"):
        return

    org_name = str(header.get("orgName") or "").strip()
    doc_number = str(header.get("docNumber") or "").strip()
    signer = str(header.get("signer") or "").strip()

    if org_name:
        title = _make_preview_paragraph(
            index=len(model.paragraphs),
            text=org_name,
            config=config,
            style_key="title",
            role="header_org",
            color="#E00000",
            align="center",
            indent_pt=0,
        )
        title.runs[0].format.font_size_pt = 30
        model.paragraphs.append(title)

    if doc_number or signer:
        text = doc_number
        align = "center"
        if signer:
            text = f"{doc_number}    签发人：{signer}" if doc_number else f"签发人：{signer}"
            align = "left"
        model.paragraphs.append(_make_preview_paragraph(
            index=len(model.paragraphs),
            text=text,
            config=config,
            style_key="body",
            role="header_doc_number",
            align=align,
            indent_pt=0,
        ))


def _append_configured_footer_note(model: "DocumentModel", config: dict[str, Any] | None) -> None:
    if not config:
        return
    cfg = _deep_merge_dict(_DEFAULT_PREVIEW_FORMAT_CONFIG, config)
    footer_note = cfg.get("footerNote", {})
    if not footer_note.get("enabled"):
        return

    body_size = _num(cfg["body"].get("fontSize"), 16)
    for role, text in (
        ("footer_cc", f"抄送：{str(footer_note.get('cc') or '').strip()}"),
        ("footer_printer", "    ".join(
            part for part in (
                str(footer_note.get("printer") or "").strip(),
                str(footer_note.get("printDate") or "").strip(),
            ) if part
        )),
    ):
        if text.strip(" 抄送："):
            para = _make_preview_paragraph(
                index=len(model.paragraphs),
                text=text,
                config=config,
                style_key="body",
                role=role,
                align="left",
                indent_pt=body_size,
            )
            para.runs[0].format.font_size_pt = max(body_size - 2, 10)
            model.paragraphs.append(para)


def _apply_configured_page_number(model: "DocumentModel", config: dict[str, Any] | None) -> None:
    if not config:
        return
    cfg = _deep_merge_dict(_DEFAULT_PREVIEW_FORMAT_CONFIG, config)
    if not cfg.get("pageNumber", {}).get("show", True):
        return

    from core.document.models import HeaderFooter

    para = _make_preview_paragraph(
        index=0,
        text="— 1 —",
        config=config,
        style_key="body",
        role="page_number",
        align="right",
        indent_pt=0,
    )
    para.runs[0].format.font_name = "宋体"
    para.runs[0].format.font_size_pt = 14
    model.footers.append(HeaderFooter(
        section_index=0,
        type="footer",
        text="— 1 —",
        paragraphs=[para],
        has_page_number=True,
    ))


def _preview_font_failures(output_path: str | Path, config: dict[str, Any] | None) -> list[str]:
    if not config:
        return []
    import zipfile
    from xml.etree import ElementTree as ET

    cfg = _deep_merge_dict(_DEFAULT_PREVIEW_FORMAT_CONFIG, config)
    expected_latin = cfg["body"].get("asciiFontFamily") or "Times New Roman"
    expected_body = cfg["body"].get("fontFamily") or "仿宋_GB2312"
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    failures: list[str] = []

    with zipfile.ZipFile(output_path, "r") as zf:
        xml_parts = [
            name for name in zf.namelist()
            if name == "word/document.xml" or name.startswith("word/header") or name.startswith("word/footer")
        ]
        for part in xml_parts:
            root = ET.fromstring(zf.read(part))
            for run in root.findall(".//w:r", ns):
                texts = [node.text or "" for node in run.findall(".//w:t", ns)]
                if not any(texts):
                    continue
                elem = run.find("./w:rPr/w:rFonts", ns)
                if elem is None:
                    snippet = "".join(texts).strip()[:20]
                    failures.append(f"{part}: 文本“{snippet}”缺少字体设置，无法确认数字字体")
                    continue
                ascii_font = elem.get(f"{{{ns['w']}}}ascii")
                hansi_font = elem.get(f"{{{ns['w']}}}hAnsi")
                east_asia = elem.get(f"{{{ns['w']}}}eastAsia")
                if not ascii_font:
                    failures.append(f"{part}: 缺少数字字体 ascii，期望 {expected_latin}")
                elif ascii_font != expected_latin:
                    failures.append(f"{part}: 数字字体 ascii={ascii_font}，期望 {expected_latin}")
                if not hansi_font:
                    failures.append(f"{part}: 缺少数字字体 hAnsi，期望 {expected_latin}")
                elif hansi_font != expected_latin:
                    failures.append(f"{part}: 数字字体 hAnsi={hansi_font}，期望 {expected_latin}")
                if east_asia and east_asia in ("MS Gothic", "MS Mincho", "MS PGothic", "MS PMincho"):
                    failures.append(f"{part}: 中文字体异常 {east_asia}，期望 {expected_body}")
    return failures


@router.post("/preview-download")
async def download_from_preview(body: PreviewDownloadRequest):
    """从前端预览数据（段落+表格）生成 docx 并返回下载。"""
    from core.document.models import (
        DocumentModel, DocumentMetadata, PageSetup,
        Paragraph, ParagraphFormat, Run, RunFormat,
        Table, TableCell,
    )
    from core.document.generator import generate_docx
    import tempfile

    # 构建 DocumentModel。format_config 来自 A4 实时预览左侧设置面板；
    # 如果没有显式传入，则保留历史行为：使用每个段落自带的 format。
    format_config = body.format_config
    ps = PageSetup()
    if body.page_setup:
        ps.margin_top_mm = body.page_setup.get('margin_top_mm', 37)
        ps.margin_bottom_mm = body.page_setup.get('margin_bottom_mm', 35)
        ps.margin_left_mm = body.page_setup.get('margin_left_mm', 28)
        ps.margin_right_mm = body.page_setup.get('margin_right_mm', 26)

    model = DocumentModel(
        metadata=DocumentMetadata(), page_setup=ps,
        paragraphs=[], tables=[], headers=[], footers=[],
    )

    _append_configured_header(model, format_config)

    for p in body.paragraphs:
        rf, pf = _formats_from_preview_config(p, format_config)
        model.paragraphs.append(Paragraph(
            index=len(model.paragraphs),
            text=p.text,
            is_heading=p.is_heading,
            heading_level=p.heading_level,
            role=p.role,
            runs=[Run(index=0, text=p.text, format=rf)],
            format=pf,
        ))

    _append_configured_footer_note(model, format_config)
    _apply_configured_page_number(model, format_config)

    # 还原表格
    if body.tables:
        for t_data in body.tables:
            table = Table(index=len(model.tables), rows=t_data.get('rows', 0), cols=t_data.get('cols', 0), cells=[])
            for c_data in t_data.get('cells', []):
                cell_paras = []
                for cp_data in c_data.get('paragraphs', []):
                    fmt = cp_data.get('format', {})
                    style_key = "table_header" if c_data.get("row") == 0 else "body"
                    cp = ParagraphData(
                        text=cp_data.get('text', ''),
                        format=fmt,
                    )
                    cp_rf, cp_pf = _formats_from_preview_config(
                        cp,
                        format_config,
                        style_key=style_key,
                        force_indent_pt=0,
                        force_align="center" if style_key == "table_header" else "left",
                    )
                    cell_paras.append(Paragraph(index=0, text=cp_data.get('text', ''), runs=[Run(index=0, text=cp_data.get('text', ''), format=cp_rf)], format=cp_pf))
                table.cells.append(TableCell(row=c_data['row'], col=c_data['col'], text=c_data.get('text', ''), paragraphs=cell_paras))
            model.tables.append(table)

    # 生成 docx
    tmp = tempfile.NamedTemporaryFile(suffix='.docx', delete=False)
    tmp.close()
    output_path = generate_docx(model, tmp.name)
    font_failures = _preview_font_failures(output_path, format_config)
    if font_failures:
        try:
            os.unlink(str(output_path))
        except OSError:
            pass
        raise HTTPException(
            status_code=422,
            detail="字体替换复核失败：" + "；".join(font_failures[:5]),
        )

    return _file_response(
        path=output_path,
        filename=_download_filename(body.source_filename or "公文预览.docx"),
        background=BackgroundTask(os.unlink, str(output_path)),
    )


# ---------------------------------------------------------------------------
#  文档优化
# ---------------------------------------------------------------------------


@router.post("/{doc_id}", response_model=OptimizeResponse)
async def run_optimize(doc_id: int, req: OptimizeRequest | None = None, db: Session = Depends(get_db)):
    """Run auto-optimization on a document."""
    doc_type = req.document_type if req else None
    apply_fixes = req.apply_fixes if req else True
    selected_rule_ids = req.selected_rule_ids if req else None
    try:
        result = svc.optimize_document(db, doc_id, doc_type, apply_fixes, selected_rule_ids)
    except svc.DocumentNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except svc.InvalidDocumentError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except svc.DocumentProcessingError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return OptimizeResponse(
        document_id=result["document_id"],
        output_path=result["output_path"],
        fixes_applied=result["fixes_applied"],
        message=f"优化完成，已应用 {result['fixes_applied']} 项修复",
    )


@router.get("/{doc_id}/download")
async def download_optimized(doc_id: int, db: Session = Depends(get_db)):
    """Download the optimized document."""
    doc = svc.get_document(db, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    try:
        out_path = svc.get_owned_optimized_output(doc)
    except svc.DocumentProcessingError as e:
        raise HTTPException(status_code=404, detail=str(e))

    return _file_response(
        path=out_path,
        filename=_download_filename(doc.filename),
    )
