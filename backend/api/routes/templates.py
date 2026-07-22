# This file is part of the Official Document AI Assistant.
# (c) 2026 Jose AI (https://www.linhut.cn)
# Licensed under the MIT License. See the LICENSE file for details.
"""
Templates management API: create, read, update templates.
支持两种模板体系：
  1. 规则模板 (rules/official/) — 用于格式检查和修复
  2. 样式模板 (templates/official/) — 用于生成 Word 模板文件
  3. 预置 .dotx 模板 (公文模板/) — 可直接使用的 Word 模板文件
"""
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from pathlib import Path
import copy
from datetime import datetime
import json
import yaml
import tempfile
import shutil
import zipfile
import os
import re
import threading
from urllib.parse import quote
from typing import Literal
from uuid import uuid4

from config import RULES_DIR, BASE_DIR, APP_DATA_DIR
from db.database import get_db
from utils.logger import logger

router = APIRouter()

# 预置 .dotx 模板目录（只读，捆绑在安装目录）
OFFICIAL_TEMPLATES_DIR = BASE_DIR / "templates" / "official"

# 真实的 .dotx 模板文件目录（来自公文模板项目）
TEMPLATES_DOTX_DIR = BASE_DIR / "公文模板"

# 生成的模板输出目录（可写，位于用户数据目录）
_GENERATED_TEMPLATES_DIR = APP_DATA_DIR / "generated_templates"
_HIDDEN_TEMPLATES_FILE = APP_DATA_DIR / "hidden_templates.json"
_UPLOADED_TEMPLATE_FILES_DIR = APP_DATA_DIR / "uploaded_template_files"
_UPLOADED_TEMPLATE_FILES_INDEX = _UPLOADED_TEMPLATE_FILES_DIR / "index.json"
_TEMPLATE_METADATA_LOCK = threading.RLock()

# template_id → 中文文件名映射（与公文模板/ 目录中的文件名对应）
_TEMPLATE_ID_TO_CN = {
    "notice": "通知", "request": "请示", "report": "报告", "letter": "函",
    "meeting": "会议纪要", "decision": "决定", "announcement": "通告",
    "notice_public": "公告", "opinion": "意见", "reply": "批复",
    "minutes": "纪要", "instruction": "指示", "work_plan": "工作方案",
    "summary": "总结", "regulation": "制度", "communique": "公报",
    "resolution": "决议", "command": "命令", "bill": "议案",
    "bulletin": "通报", "table_sign": "桌签",
}

_FUJIAN_TEMPLATE_SPECS = [
    ("fujian_province", "福建省人民政府公文模板", "福建省级机关常用公文格式基底"),
]

_TEMPLATE_ID_TO_CN.update({template_id: name for template_id, name, _ in _FUJIAN_TEMPLATE_SPECS})

# 需要在模板文件中替换的品牌名
_BRAND_REPLACEMENTS = [
    ("小恐龙", "Jose AI"),
    ("小恐龙公文", "Jose AI公文"),
    ("xkonglong", "Jose AI"),
]
_SIMPLE_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
StyleReadSource = Literal["all", "official", "custom", "user"]
StyleWriteSource = Literal["custom", "user"]
_STYLE_READ_SOURCES = frozenset({"all", "official", "custom", "user"})
_STYLE_WRITE_SOURCES = frozenset({"custom", "user"})


def _safe_simple_id(value: str, label: str = "id") -> str:
    cleaned = (value or "").strip()
    if len(cleaned) > 128 or not _SIMPLE_ID_RE.fullmatch(cleaned):
        raise HTTPException(
            status_code=400,
            detail=f"{label} may only contain letters, numbers, underscores, and hyphens",
        )
    return cleaned


def _require_style_write_source(source: str) -> None:
    if source == "official":
        raise HTTPException(status_code=403, detail="Official templates are read-only")
    if source not in _STYLE_WRITE_SOURCES:
        raise HTTPException(
            status_code=400,
            detail="Template write source must be custom or user",
        )


def _require_style_read_source(source: str) -> None:
    if source not in _STYLE_READ_SOURCES:
        raise HTTPException(
            status_code=400,
            detail="Template source must be all, official, custom, or user",
        )


def _safe_filename_stem(filename: str) -> str:
    stem = Path(filename or "template").stem
    safe = re.sub(r"[^\w一-鿿._-]+", "_", stem).strip(" ._-")
    return safe or "template"


def _atomic_write_json(path: Path, data: object) -> None:
    """Durably replace a small JSON metadata file without exposing partial data."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            temp_path = Path(handle.name)
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        temp_path = None
        if os.name != "nt":
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)


def _load_template_file_index() -> dict[str, dict]:
    with _TEMPLATE_METADATA_LOCK:
        if not _UPLOADED_TEMPLATE_FILES_INDEX.exists():
            return {}
        try:
            data = json.loads(_UPLOADED_TEMPLATE_FILES_INDEX.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return data if isinstance(data, dict) else {}


def _save_template_file_index(index: dict[str, dict]) -> None:
    with _TEMPLATE_METADATA_LOCK:
        _atomic_write_json(_UPLOADED_TEMPLATE_FILES_INDEX, index)


def _template_file_path(record: dict) -> Path:
    stored = Path(str(record.get("stored_filename") or ""))
    path = (_UPLOADED_TEMPLATE_FILES_DIR / stored.name).resolve()
    root = _UPLOADED_TEMPLATE_FILES_DIR.resolve()
    try:
        path.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="模板文件路径无效")
    return path


def _template_file_response(path: Path, filename: str) -> FileResponse:
    encoded = quote(filename)
    response = FileResponse(
        path=str(path),
        filename=filename,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )
    response.headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{encoded}"
    return response


def _temporary_template_file_response(
    path: Path,
    filename: str,
    temp_dir: Path,
) -> FileResponse:
    encoded = quote(filename)
    response = FileResponse(
        path=str(path),
        filename=filename,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        background=BackgroundTask(shutil.rmtree, temp_dir, ignore_errors=True),
    )
    response.headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{encoded}"
    return response


class TemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    document_type: str
    description: str = Field(min_length=1, max_length=500)
    icon: str = Field(default="📄", min_length=1, max_length=8)
    custom_rules: list[dict] | None = None


class TemplateRulesUpdate(BaseModel):
    check_rules: list[dict]


_RULE_FIELD_SPECS = (
    {"value": "title.font", "label": "标题字体", "group": "标题", "action": "set_font", "target": "title"},
    {"value": "title.size", "label": "标题字号", "group": "标题", "action": "set_size", "target": "title"},
    {"value": "title.align", "label": "标题对齐", "group": "标题", "action": "set_alignment", "target": "title"},
    {"value": "title.bold", "label": "标题加粗", "group": "标题", "action": "set_bold", "target": "title"},
    {"value": "body.font", "label": "正文字体", "group": "正文", "action": "set_font", "target": "body"},
    {"value": "body.size", "label": "正文字号", "group": "正文", "action": "set_size", "target": "body"},
    {"value": "body.align", "label": "正文对齐", "group": "正文", "action": "set_alignment", "target": "body"},
    {"value": "body.first_line_indent", "label": "正文首行缩进", "group": "正文", "action": "set_first_line_indent", "target": "body"},
    {"value": "body.line_spacing", "label": "正文行距", "group": "正文", "action": "set_line_spacing", "target": "body"},
    {"value": "signature.align", "label": "落款对齐", "group": "落款", "action": "set_alignment", "target": "signature"},
    {"value": "date.align", "label": "日期对齐", "group": "落款", "action": "set_alignment", "target": "signature"},
    {"value": "recipient.font", "label": "主送机关字体", "group": "其他", "action": "set_font", "target": "recipient"},
    {"value": "cc.font", "label": "抄送机关字体", "group": "其他", "action": "set_font", "target": "cc"},
    {"value": "attachment.first_line_indent", "label": "附件首行缩进", "group": "其他", "action": "set_first_line_indent", "target": "attachment"},
    {"value": "page_setup.margins.top", "label": "上边距", "group": "页面"},
    {"value": "page_setup.margins.bottom", "label": "下边距", "group": "页面"},
    {"value": "page_setup.margins.left", "label": "左边距", "group": "页面"},
    {"value": "page_setup.margins.right", "label": "右边距", "group": "页面"},
    {"value": "page_setup.paper_width_mm", "label": "纸张宽度", "group": "页面"},
    {"value": "page_setup.paper_height_mm", "label": "纸张高度", "group": "页面"},
)
_RULE_FIELD_BY_VALUE = {item["value"]: item for item in _RULE_FIELD_SPECS}


def _normalize_check_rules(check_rules: list[dict]) -> list[dict]:
    from core.rules.checker import SUPPORTED_CHECK_FIELDS

    normalized: list[dict] = []
    seen_ids: set[str] = set()
    for item in check_rules:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="每条检查规则必须是对象")
        rule = copy.deepcopy(item)
        rule_id = str(rule.get("id") or "").strip()
        name = str(rule.get("name") or "").strip()
        severity = str(rule.get("severity") or "").strip()
        field = str(rule.get("field") or "").strip()
        message = str(rule.get("message") or "").strip()
        if not rule_id or not name or not field or not message or rule.get("expected") in (None, ""):
            raise HTTPException(status_code=400, detail="检查规则字段不完整")
        if rule_id in seen_ids:
            raise HTTPException(status_code=400, detail=f"检查规则 ID 重复: {rule_id}")
        if severity not in {"P0", "P1", "P2"}:
            raise HTTPException(status_code=400, detail=f"无效严重程度: {severity}")
        if field not in SUPPORTED_CHECK_FIELDS:
            raise HTTPException(status_code=400, detail=f"当前不支持检查字段: {field}")
        rule.update({
            "id": rule_id,
            "name": name,
            "severity": severity,
            "field": field,
            "message": message,
        })
        normalized.append(rule)
        seen_ids.add(rule_id)
    return normalized


def _fix_value(field: str, expected):
    if field.endswith(".bold"):
        if isinstance(expected, bool):
            return expected
        value = str(expected).strip().lower()
        if value in {"true", "1", "yes", "是"}:
            return True
        if value in {"false", "0", "no", "否"}:
            return False
        raise HTTPException(status_code=400, detail=f"{field} 的期望值必须是 true 或 false")
    return expected


def _build_fix_rules(check_rules: list[dict]) -> list[dict]:
    fixes: list[dict] = []
    for index, check_rule in enumerate(check_rules, start=1):
        spec = _RULE_FIELD_BY_VALUE.get(check_rule["field"])
        if not spec or not spec.get("action"):
            continue
        fixes.append({
            "id": f"FIX-EDIT-{index:03d}",
            "ref_check": check_rule["id"],
            "action": spec["action"],
            "target": spec["target"],
            "value": _fix_value(check_rule["field"], check_rule.get("expected")),
        })
    return fixes


class TemplateDuplicateRequest(BaseModel):
    target_id: str | None = None
    name: str | None = None


class TemplateApplyPreviewRequest(BaseModel):
    paragraphs: list[dict]
    tables: list[dict] | None = None
    source_filename: str | None = None


def _load_hidden_template_ids() -> set[str]:
    with _TEMPLATE_METADATA_LOCK:
        if not _HIDDEN_TEMPLATES_FILE.exists():
            return set()
        try:
            data = json.loads(_HIDDEN_TEMPLATES_FILE.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return set()
        if not isinstance(data, list):
            return set()
        return {item for item in data if isinstance(item, str) and _SIMPLE_ID_RE.fullmatch(item)}


def _save_hidden_template_ids(template_ids: set[str]) -> None:
    with _TEMPLATE_METADATA_LOCK:
        _atomic_write_json(_HIDDEN_TEMPLATES_FILE, sorted(template_ids))


def _hide_official_template(template_id: str) -> None:
    with _TEMPLATE_METADATA_LOCK:
        hidden = _load_hidden_template_ids()
        hidden.add(template_id)
        _save_hidden_template_ids(hidden)


def _restore_official_template(template_id: str | None = None) -> int:
    with _TEMPLATE_METADATA_LOCK:
        hidden = _load_hidden_template_ids()
        before = len(hidden)
        if template_id:
            hidden.discard(template_id)
        else:
            hidden.clear()
        _save_hidden_template_ids(hidden)
        return before - len(hidden)


@router.get("/list")
async def list_templates():
    """List all available document templates."""
    templates = [
        # 政府机关公文（8个）
        {
            "id": "notice",
            "name": "通知",
            "description": "工作通知、会议通知、部署通知等",
            "icon": "📄",
            "category": "government",
            "rule_file": "notice.yaml",
            "enabled": True
        },
        {
            "id": "request",
            "name": "请示",
            "description": "请示上级批准事项",
            "icon": "📝",
            "category": "government",
            "rule_file": "request.yaml",
            "enabled": True
        },
        {
            "id": "report",
            "name": "报告",
            "description": "工作报告、情况报告等",
            "icon": "📊",
            "category": "government",
            "rule_file": "report.yaml",
            "enabled": True
        },
        {
            "id": "letter",
            "name": "函",
            "description": "机关之间商洽工作、询问和答复问题",
            "icon": "✉️",
            "category": "government",
            "rule_file": "letter.yaml",
            "enabled": True
        },
        {
            "id": "meeting",
            "name": "会议纪要",
            "description": "记录会议主要情况和议定事项",
            "icon": "🗓️",
            "category": "government",
            "rule_file": "meeting.yaml",
            "enabled": True
        },
        {
            "id": "decision",
            "name": "决定",
            "description": "对重要事项作出决策和部署",
            "icon": "⚖️",
            "category": "government",
            "rule_file": "decision.yaml",
            "enabled": True
        },
        {
            "id": "announcement",
            "name": "通告",
            "description": "公布社会有关方面应当遵守或周知的事项",
            "icon": "📢",
            "category": "government",
            "rule_file": "announcement.yaml",
            "enabled": True
        },
        {
            "id": "notice_public",
            "name": "公告",
            "description": "向国内外宣布重要事项或法定事项",
            "icon": "📣",
            "category": "government",
            "rule_file": "notice_public.yaml",
            "enabled": True
        },
        # 扩展公文（4个）
        {
            "id": "opinion",
            "name": "意见",
            "description": "对重要问题提出见解和处理办法",
            "icon": "💡",
            "category": "government",
            "rule_file": "opinion.yaml",
            "enabled": True
        },
        {
            "id": "reply",
            "name": "批复",
            "description": "答复下级机关请示事项",
            "icon": "✅",
            "category": "government",
            "rule_file": "reply.yaml",
            "enabled": True
        },
        {
            "id": "minutes",
            "name": "纪要",
            "description": "记载会议主要精神和议定事项",
            "icon": "📋",
            "category": "government",
            "rule_file": "minutes.yaml",
            "enabled": True
        },
        {
            "id": "instruction",
            "name": "指示",
            "description": "对下级机关布置工作、提出要求",
            "icon": "👉",
            "category": "government",
            "rule_file": "instruction.yaml",
            "enabled": True
        },
        # 其他常用（3个）
        {
            "id": "work_plan",
            "name": "工作方案",
            "description": "工作计划和实施方案",
            "icon": "📋",
            "category": "common",
            "rule_file": "work_plan.yaml",
            "enabled": True
        },
        {
            "id": "summary",
            "name": "总结",
            "description": "工作总结和汇报总结",
            "icon": "📝",
            "category": "common",
            "rule_file": "summary.yaml",
            "enabled": True
        },
        {
            "id": "regulation",
            "name": "制度",
            "description": "规章制度和管理办法",
            "icon": "📜",
            "category": "common",
            "rule_file": "regulation.yaml",
            "enabled": True
        },
        # 新增公文类型（6个）
        {
            "id": "communique",
            "name": "公报",
            "description": "公布重要决定或重大事件",
            "icon": "📰",
            "category": "government",
            "rule_file": "communique.yaml",
            "enabled": True
        },
        {
            "id": "resolution",
            "name": "决议",
            "description": "经会议讨论通过的重大决策事项",
            "icon": "🗳️",
            "category": "government",
            "rule_file": "resolution.yaml",
            "enabled": True
        },
        {
            "id": "command",
            "name": "命令",
            "description": "公布行政法规和规章、宣布施行重大强制性措施",
            "icon": "⚔️",
            "category": "government",
            "rule_file": "command.yaml",
            "enabled": True
        },
        {
            "id": "bill",
            "name": "议案",
            "description": "向人大或常委会提请审议事项",
            "icon": "📑",
            "category": "government",
            "rule_file": "bill.yaml",
            "enabled": True
        },
        {
            "id": "bulletin",
            "name": "通报",
            "description": "表彰先进、批评错误、传达重要情况",
            "icon": "🔔",
            "category": "government",
            "rule_file": "bulletin.yaml",
            "enabled": True
        },
        {
            "id": "table_sign",
            "name": "桌签",
            "description": "会议桌签和席卡模板",
            "icon": "🏷️",
            "category": "common",
            "rule_file": "table_sign.yaml",
            "enabled": True
        },
        {
            "id": "technical_proposal",
            "name": "技术方案",
            "description": "项目技术方案、实施方案、技术报告",
            "icon": "🔧",
            "category": "common",
            "rule_file": "technical_proposal.yaml",
            "enabled": True
        },
    ]
    templates.extend([
        {
            "id": template_id,
            "name": name,
            "description": description,
            "icon": "闽",
            "category": "regional",
            "rule_file": f"{template_id}.yaml",
            "enabled": True,
        }
        for template_id, name, description in _FUJIAN_TEMPLATE_SPECS
    ])
    hidden_template_ids = _load_hidden_template_ids()
    templates = [template for template in templates if template["id"] not in hidden_template_ids]

    # Check which rule files exist
    existing_ids = set()
    for template in templates:
        rule_path = RULES_DIR / template["rule_file"]
        template["has_rules"] = rule_path.exists()
        template["source"] = "official"
        existing_ids.add(template["id"])

    # 扫描 custom_rules 和 user_rules 目录，追加自定义模板
    from config import CUSTOM_RULES_DIR, USER_RULES_DIR
    for source, src_label in [(CUSTOM_RULES_DIR, "custom"), (USER_RULES_DIR, "user")]:
        if not source.exists():
            continue
        for f in sorted(source.glob("*.yaml")):
            if f.stem.startswith("_"):
                continue
            if f.stem in existing_ids:
                continue
            existing_ids.add(f.stem)
            # 尝试读取用户保存的模板元数据
            try:
                with open(f, "r", encoding="utf-8") as fh:
                    data = yaml.safe_load(fh) or {}
                name = data.get("template_name", f.stem)
                description = data.get("description") or f"自定义规则（{src_label}）"
                icon = data.get("icon") or "📋"
            except Exception:
                name = f.stem
                description = f"自定义规则（{src_label}）"
                icon = "📋"
            templates.append({
                "id": f.stem,
                "name": name,
                "description": description,
                "icon": icon,
                "category": "custom",
                "rule_file": f.name,
                "has_rules": True,
                "source": src_label,
                "enabled": True,
            })

    logger.info(f"Listed {len(templates)} templates")
    return {
        "templates": templates,
        "hidden_template_ids": sorted(hidden_template_ids),
        "hidden_total": len(hidden_template_ids),
    }


# NOTE: /{template_id} 必须放在所有 /xxx 固定路由之后，否则会拦截 /create、/extract 等路径


@router.get("/rule-fields")
async def list_rule_fields():
    """Return the authoritative fields accepted by the visual rule editor."""
    return {
        "fields": [
            {key: item[key] for key in ("value", "label", "group")}
            for item in _RULE_FIELD_SPECS
        ]
    }


@router.post("/create")
async def create_template(data: TemplateCreate):
    """Create a new template from basic model."""
    from core.rules.manager import delete_rule, save_rule, validate_rule
    from core.template import style_manager
    import services.document_service as svc

    doc_type = _safe_simple_id(data.document_type, "document_type")
    if style_manager.get_template(doc_type, "user") is not None:
        raise HTTPException(status_code=400, detail="Template already exists")
    from core.rules.manager import get_rule_content
    if get_rule_content(doc_type, "user") is not None:
        raise HTTPException(status_code=400, detail="Template already exists")

    default_checks = [
        {
            "id": f"CHK-{doc_type.upper()[:3]}001",
            "name": "标题字体检查",
            "severity": "P0",
            "field": "title.font",
            "expected": "方正小标宋简体",
            "message": "标题应使用方正小标宋简体",
        },
        {
            "id": f"CHK-{doc_type.upper()[:3]}002",
            "name": "正文字体检查",
            "severity": "P0",
            "field": "body.font",
            "expected": "仿宋_GB2312",
            "message": "正文应使用仿宋_GB2312字体",
        },
    ]
    check_rules = _normalize_check_rules(data.custom_rules or default_checks)
    template_data = {
        "template_name": data.name,
        "document_type": doc_type,
        "description": data.description,
        "icon": data.icon,
        "title": {
            "font": "方正小标宋简体",
            "font_fallback": "SimSun",
            "size": "22pt",
            "align": "center",
            "bold": False
        },
        "body": {
            "font": "仿宋_GB2312",
            "font_fallback": "FangSong",
            "size": "16pt",
            "line_spacing": "28.95pt",
            "first_line_indent": "2em",
            "align": "justify"
        },
        "check_rules": check_rules,
        "fix_rules": _build_fix_rules(check_rules),
        "__replace_check_rules": True,
        "__replace_fix_rules": True,
    }

    style_data = {
        "id": doc_type,
        "name": data.name,
        "type": doc_type,
        "version": "1.0",
        "author": "HaoXiang Huang",
        "description": data.description,
        "icon": data.icon,
        "page": {
            "size": "A4",
            "margins": {"top": "3.7cm", "bottom": "3.5cm", "left": "2.8cm", "right": "2.6cm"},
        },
        "styles": {
            "title": {
                "style_name": "公文标题", "font_east_asia": "方正小标宋简体",
                "font_latin": "Times New Roman", "size": "22pt", "bold": False,
                "alignment": "center", "space_after": "20pt",
            },
            "body": {
                "style_name": "公文正文", "font_east_asia": "仿宋_GB2312",
                "font_latin": "Times New Roman", "size": "16pt", "alignment": "justify",
                "line_spacing": "28.95pt", "first_line_indent": "2em",
            },
            "subtitle": {
                "style_name": "公文小标题", "font_east_asia": "黑体",
                "font_latin": "Times New Roman", "size": "16pt", "bold": True,
                "alignment": "left", "line_spacing": "28.95pt", "first_line_indent": "2em",
            },
            "signature": {
                "style_name": "公文落款", "font_east_asia": "仿宋_GB2312",
                "font_latin": "Times New Roman", "size": "16pt", "alignment": "right",
            },
        },
        "sample": {
            "title": data.name,
            "paragraphs": ["主送机关：", "", "正文内容。", "", "（单位名称）", "XXXX年XX月XX日"],
        },
    }

    try:
        validate_rule(template_data)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not save_rule(doc_type, template_data, "user"):
        raise HTTPException(status_code=500, detail="Failed to save template rules")
    if not style_manager.save_template(doc_type, style_data, "user"):
        delete_rule(doc_type, "user")
        raise HTTPException(status_code=500, detail="Failed to save template style")

    logger.info(f"Created template: {doc_type}")
    svc.clear_rule_cache()
    return {
        "success": True,
        "template_id": doc_type,
        "message": f"模板 {data.name} 创建成功"
    }


@router.get("/deleted/list")
async def list_deleted_templates():
    """List user-hidden built-in templates."""
    hidden = sorted(_load_hidden_template_ids())
    return {"template_ids": hidden, "total": len(hidden)}


@router.post("/deleted/restore")
async def restore_deleted_templates(template_id: str | None = None):
    """Restore one or all user-hidden built-in templates."""
    safe_id = _safe_simple_id(template_id, "template_id") if template_id else None
    restored = _restore_official_template(safe_id)
    return {"success": True, "restored": restored}


@router.post("/{template_id}/duplicate")
async def duplicate_template(template_id: str, body: TemplateDuplicateRequest | None = None):
    """Copy a template into the user layer so it can be edited independently."""
    template_id = _safe_simple_id(template_id, "template_id")
    body = body or TemplateDuplicateRequest()

    from core.rules.manager import get_rule_content, load_rules_merged, save_rule, validate_rule
    from core.template import style_manager
    import services.document_service as svc

    def _target_exists(candidate: str) -> bool:
        return (
            get_rule_content(candidate, "all") is not None
            or style_manager.get_template(candidate, "all") is not None
        )

    if body.target_id:
        target_id = _safe_simple_id(body.target_id, "target_id")
        if _target_exists(target_id):
            raise HTTPException(status_code=400, detail=f"Template already exists: {target_id}")
    else:
        base_id = f"{template_id}_copy"
        target_id = base_id
        index = 2
        while _target_exists(target_id):
            target_id = f"{base_id}_{index}"
            index += 1

    source_rules = load_rules_merged(template_id)
    if not source_rules.get("check_rules") and not source_rules.get("title") and not source_rules.get("body"):
        raise HTTPException(status_code=404, detail=f"Template not found: {template_id}")

    source_name = source_rules.get("template_name") or template_id
    target_name = (body.name or f"{source_name} 副本").strip()
    if not target_name:
        target_name = f"{source_name} 副本"

    new_rules = copy.deepcopy(source_rules)
    new_rules["template_name"] = target_name
    new_rules["document_type"] = target_id
    new_rules["__replace_check_rules"] = True
    new_rules["__replace_fix_rules"] = True

    try:
        validate_rule(new_rules)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if not save_rule(target_id, new_rules, "user"):
        raise HTTPException(status_code=500, detail="Failed to save duplicated template rules")

    copied_style = False
    source_style = style_manager.get_template(template_id, "all")
    if source_style:
        new_style = copy.deepcopy(source_style)
        new_style.pop("_source", None)
        new_style.pop("_path", None)
        new_style["name"] = target_name
        new_style["id"] = target_id
        copied_style = style_manager.save_template(target_id, new_style, "user")

    svc.clear_rule_cache()
    return {
        "success": True,
        "source_template_id": template_id,
        "template_id": target_id,
        "name": target_name,
        "source_type": "user",
        "copied_style": copied_style,
    }


@router.delete("/{template_id}")
async def delete_template(template_id: str, source_type: str = Query("user", pattern="^(official|custom|user)$")):
    """Delete a template from the user's view.

    Official templates are bundled read-only resources, so deletion is stored as
    a user-level hidden marker instead of mutating packaged files.
    """
    template_id = _safe_simple_id(template_id, "template_id")
    if source_type == "official":
        _hide_official_template(template_id)
        return {
            "success": True,
            "template_id": template_id,
            "source_type": source_type,
            "action": "hidden",
        }

    from core.rules.manager import delete_rule, get_rule_content
    from core.template import style_manager
    import services.document_service as svc

    rule_exists = get_rule_content(template_id, source_type) is not None
    style_exists = style_manager.get_template(template_id, source_type) is not None
    if not rule_exists and not style_exists:
        raise HTTPException(status_code=404, detail=f"Template not found: {template_id}")

    if style_exists and not style_manager.delete_template(template_id, source_type):
        raise HTTPException(status_code=500, detail="Failed to delete template style")
    if rule_exists and not delete_rule(template_id, source_type):
        raise HTTPException(status_code=500, detail="Failed to delete template rules")

    svc.clear_rule_cache()
    return {
        "success": True,
        "template_id": template_id,
        "source_type": source_type,
    }


@router.put("/{template_id}/rules")
async def update_template_rules(template_id: str, body: TemplateRulesUpdate):
    """Save template check rules to the user override layer."""
    template_id = _safe_simple_id(template_id, "template_id")

    from core.rules.manager import load_rules_merged, save_rule, validate_rule
    import services.document_service as svc

    rules = load_rules_merged(template_id)
    if not rules.get("template_name"):
        rules["template_name"] = template_id
    rules["document_type"] = rules.get("document_type") or template_id
    check_rules = _normalize_check_rules(body.check_rules)
    rules["check_rules"] = check_rules
    rules["fix_rules"] = _build_fix_rules(check_rules)
    rules["__replace_check_rules"] = True
    rules["__replace_fix_rules"] = True

    try:
        validate_rule(rules)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if not save_rule(template_id, rules, "user"):
        raise HTTPException(status_code=500, detail="Failed to save template rules")

    svc.clear_rule_cache()
    return {
        "success": True,
        "template_id": template_id,
        "check_rules_count": len(check_rules),
        "fix_rules_count": len(rules["fix_rules"]),
        "source_type": "user",
    }


# ---------------------------------------------------------------------------
#  用户上传 Word 模板文件，并作为内容导出的格式基底
# ---------------------------------------------------------------------------

@router.get("/files/list")
async def list_uploaded_template_files():
    """List uploaded Word template files stored in APP_DATA_DIR."""
    with _TEMPLATE_METADATA_LOCK:
        index = _load_template_file_index()
        templates = []
        changed = False
        for template_id, record in sorted(index.items(), key=lambda item: item[1].get("created_at", ""), reverse=True):
            try:
                path = _template_file_path(record)
            except HTTPException:
                changed = True
                continue
            if not path.exists():
                changed = True
                continue
            templates.append({
                "id": template_id,
                "name": record.get("name") or template_id,
                "original_filename": record.get("original_filename") or path.name,
                "created_at": record.get("created_at"),
                "size": path.stat().st_size,
            })
        if changed:
            valid_ids = {item["id"] for item in templates}
            _save_template_file_index({tid: rec for tid, rec in index.items() if tid in valid_ids})
    return {"templates": templates, "total": len(templates)}


@router.post("/files/upload")
async def upload_template_file(file: UploadFile = File(...)):
    """Upload a .docx/.dotx file as a reusable formatting base."""
    filename = file.filename or "template.docx"
    ext = Path(filename).suffix.lower()
    if ext not in (".docx", ".dotx"):
        raise HTTPException(status_code=400, detail="仅支持 .docx/.dotx 模板文件")

    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="模板文件为空")
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="模板文件过大（超过 50MB）")

    _UPLOADED_TEMPLATE_FILES_DIR.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    stem = _safe_filename_stem(filename)
    template_id = f"tpl_{timestamp}_{uuid4().hex[:8]}"
    stored_filename = f"{template_id}.docx"
    tmp_dir = Path(tempfile.mkdtemp(prefix="template_upload_"))
    tmp_path = tmp_dir / f"{stem}{ext}"
    target_path = _UPLOADED_TEMPLATE_FILES_DIR / stored_filename

    try:
        tmp_path.write_bytes(content)
        if not zipfile.is_zipfile(tmp_path):
            raise HTTPException(status_code=400, detail="模板文件不是有效的 Word OOXML 文件")

        from core.document.template_applier import copy_template_to_docx
        from core.document.parser import parse_docx

        copy_template_to_docx(tmp_path, target_path)
        parsed = parse_docx(str(target_path))
        paragraph_count = len([p for p in parsed.paragraphs if (p.text or "").strip()])

        record = {
            "id": template_id,
            "name": stem,
            "original_filename": filename,
            "stored_filename": stored_filename,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "paragraph_count": paragraph_count,
        }
        with _TEMPLATE_METADATA_LOCK:
            index = _load_template_file_index()
            index[template_id] = record
            _save_template_file_index(index)
        return {"success": True, "template": record}
    except HTTPException:
        if target_path.exists():
            target_path.unlink()
        raise
    except Exception as e:
        if target_path.exists():
            target_path.unlink()
        logger.error(f"Upload template file failed: {e}")
        raise HTTPException(status_code=500, detail=f"模板上传失败: {str(e)}")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@router.delete("/files/{template_file_id}")
async def delete_uploaded_template_file(template_file_id: str):
    """Delete an uploaded template file from user data."""
    template_file_id = _safe_simple_id(template_file_id, "template_file_id")
    with _TEMPLATE_METADATA_LOCK:
        index = _load_template_file_index()
        record = index.get(template_file_id)
        if not record:
            raise HTTPException(status_code=404, detail="模板文件不存在")
        path = _template_file_path(record)
        staged_path: Path | None = None
        try:
            if path.exists():
                staged_path = path.with_name(f".{path.name}.{uuid4().hex}.deleting")
                path.replace(staged_path)
            index.pop(template_file_id, None)
            _save_template_file_index(index)
        except Exception as e:
            if staged_path is not None and staged_path.exists() and not path.exists():
                staged_path.replace(path)
            if isinstance(e, HTTPException):
                raise
            logger.error(f"Failed to stage uploaded template deletion {path}: {e}")
            raise HTTPException(status_code=500, detail="模板文件删除失败") from e

    if staged_path is not None:
        try:
            staged_path.unlink()
        except OSError as e:
            logger.error(f"Failed to remove staged template file {staged_path}: {e}")
            with _TEMPLATE_METADATA_LOCK:
                if staged_path.exists() and not path.exists():
                    staged_path.replace(path)
                current = _load_template_file_index()
                current[template_file_id] = record
                _save_template_file_index(current)
            raise HTTPException(status_code=500, detail="模板文件删除失败") from e
    return {"success": True, "template_file_id": template_file_id}


@router.post("/files/{template_file_id}/apply/{doc_id}/download")
async def apply_uploaded_template_to_document(
    template_file_id: str,
    doc_id: int,
    use_optimized: bool = True,
    db: Session = Depends(get_db),
):
    """Export a document's content using an uploaded Word template as the formatting base."""
    from services import document_service as svc
    from core.document.parser import parse_docx
    from core.document.template_applier import generate_docx_with_template
    from config import TEMP_DIR

    template_file_id = _safe_simple_id(template_file_id, "template_file_id")
    index = _load_template_file_index()
    record = index.get(template_file_id)
    if not record:
        raise HTTPException(status_code=404, detail="模板文件不存在")
    template_path = _template_file_path(record)
    if not template_path.exists():
        raise HTTPException(status_code=404, detail="模板文件已丢失，请重新上传")

    doc = svc.get_document(db, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="文档不存在")

    try:
        source_path = svc.get_current_document_source(doc) if use_optimized else Path(doc.file_path)
    except svc.DocumentProcessingError as e:
        raise HTTPException(status_code=404, detail=str(e))
    if not source_path.is_file():
        raise HTTPException(status_code=404, detail="源文档文件不存在")

    content_model = parse_docx(str(source_path))
    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix="template-download-", dir=str(TEMP_DIR)))
    out_name = svc.export_filename(doc.filename, "套用模板")
    out_path = temp_dir / out_name
    try:
        generate_docx_with_template(content_model, template_path, out_path)
    except ValueError as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        logger.error(f"Apply uploaded template failed: {e}")
        raise HTTPException(status_code=500, detail=f"套用模板失败: {str(e)}")

    return _temporary_template_file_response(out_path, out_name, temp_dir)


@router.post("/files/{template_file_id}/apply-preview/download")
async def apply_uploaded_template_to_preview(
    template_file_id: str,
    body: TemplateApplyPreviewRequest,
):
    """Export the current preview content using an uploaded Word template as the formatting base."""
    from services.document_service import export_filename
    from core.document.models import (
        DocumentModel, DocumentMetadata, PageSetup,
        Paragraph, Run, RunFormat, Table, TableCell,
    )
    from core.document.template_applier import generate_docx_with_template
    from config import TEMP_DIR

    template_file_id = _safe_simple_id(template_file_id, "template_file_id")
    index = _load_template_file_index()
    record = index.get(template_file_id)
    if not record:
        raise HTTPException(status_code=404, detail="模板文件不存在")
    template_path = _template_file_path(record)
    if not template_path.exists():
        raise HTTPException(status_code=404, detail="模板文件已丢失，请重新上传")

    model = DocumentModel(
        metadata=DocumentMetadata(),
        page_setup=PageSetup(),
        paragraphs=[],
        tables=[],
        headers=[],
        footers=[],
    )
    for item in body.paragraphs:
        text = str(item.get("text") or "")
        model.paragraphs.append(Paragraph(
            index=len(model.paragraphs),
            text=text,
            role=item.get("role"),
            is_heading=bool(item.get("is_heading")),
            heading_level=item.get("heading_level"),
            runs=[Run(index=0, text=text, format=RunFormat())],
        ))

    if body.tables:
        for t_data in body.tables:
            table = Table(index=len(model.tables), rows=t_data.get("rows", 0), cols=t_data.get("cols", 0), cells=[])
            for c_data in t_data.get("cells", []):
                cell_paras = []
                for cp_data in c_data.get("paragraphs", []):
                    text = str(cp_data.get("text") or "")
                    cell_paras.append(Paragraph(
                        index=len(cell_paras),
                        text=text,
                        runs=[Run(index=0, text=text, format=RunFormat())],
                    ))
                table.cells.append(TableCell(
                    row=c_data["row"],
                    col=c_data["col"],
                    text=c_data.get("text", ""),
                    paragraphs=cell_paras,
                ))
            model.tables.append(table)

    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix="template-preview-", dir=str(TEMP_DIR)))
    out_name = export_filename(body.source_filename or "套用模板预览.docx", "套用模板")
    out_path = temp_dir / out_name
    try:
        generate_docx_with_template(model, template_path, out_path)
    except ValueError as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        shutil.rmtree(temp_dir, ignore_errors=True)
        logger.error(f"Apply uploaded template to preview failed: {e}")
        raise HTTPException(status_code=500, detail=f"套用模板失败: {str(e)}")

    return _temporary_template_file_response(out_path, out_name, temp_dir)


# ---------------------------------------------------------------------------
#  导入文档自动生成模板规则
# ---------------------------------------------------------------------------

class SaveExtractedRequest(BaseModel):
    template_name: str
    document_type: str
    yaml_content: dict


@router.post("/extract")
async def extract_template_from_doc(file: UploadFile = File(...)):
    """从上传的 .docx 文档中提取格式信息，生成规则模板预览。"""
    import re

    # 校验文件类型
    filename = file.filename or "document.docx"
    ext = Path(filename).suffix.lower()
    if ext not in ('.docx', '.doc', '.wps'):
        raise HTTPException(status_code=400, detail="仅支持 .docx/.doc/.wps 格式")

    # 保存到临时目录
    tmp_dir = Path(tempfile.mkdtemp())
    safe_name = re.sub(r'[^\w一-鿿._-]', '_', Path(filename).name)
    tmp_path = tmp_dir / safe_name

    try:
        content = await file.read()
        with open(tmp_path, 'wb') as f:
            f.write(content)

        # .doc/.wps 转 .docx
        if ext in ('.doc', '.wps'):
            from core.document.converter import convert_to_docx
            tmp_path = convert_to_docx(tmp_path, tmp_dir)

        # 提取格式
        from core.document.format_extractor import (
            FormatExtractor, extract_format_from_docx, generate_template_from_docx
        )
        from core.document.parser import parse_docx

        model = parse_docx(str(tmp_path))
        extractor = FormatExtractor(model)
        extracted = extractor.extract_all()

        # 生成默认模板名和类型标识
        stem = Path(filename).stem
        # 尝试从文件名推断类型
        from services.document_service import _detect_doc_type
        doc_type = _detect_doc_type(filename)
        template_name = stem

        # 生成 YAML 预览
        yaml_data = extractor.generate_yaml(template_name, doc_type)
        yaml_preview = yaml.dump(yaml_data, allow_unicode=True, default_flow_style=False)

        return {
            "success": True,
            "template_name": template_name,
            "document_type": doc_type,
            "format_info": extracted['summary'],
            "sections": extracted['sections'],
            "page_setup": extracted['page_setup'],
            "check_rules_count": len(yaml_data.get('check_rules', [])),
            "fix_rules_count": len(yaml_data.get('fix_rules', [])),
            "yaml_preview": yaml_preview,
            "yaml_content": yaml_data,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Format extraction failed: {e}")
        raise HTTPException(status_code=500, detail=f"格式提取失败: {str(e)}")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@router.post("/{template_id}/preview")
async def preview_template(template_id: str):
    """根据模板规则生成示例文档，返回 A4 预览数据。"""
    from core.rules.manager import load_rules_merged
    from core.document.models import (
        DocumentModel, DocumentMetadata, PageSetup,
        Paragraph, ParagraphFormat, Run, RunFormat,
    )

    try:
        rules = load_rules_merged(template_id)
    except Exception:
        raise HTTPException(status_code=404, detail=f"模板 {template_id} 不存在")

    # 从规则中提取格式定义
    title_fmt = rules.get('doc_title') or rules.get('title') or {}
    h1_fmt = rules.get('heading_1') or {}
    h2_fmt = rules.get('heading_2') or {}
    h3_fmt = rules.get('heading_3') or {}
    body_fmt = rules.get('body') or {}
    sig_fmt = rules.get('signature') or {}
    date_fmt = rules.get('date') or {}
    ps = rules.get('page_setup', {})
    margins = ps.get('margins', {})

    def _parse_pt(val, default=16):
        if val is None: return default
        s = str(val).replace('pt', '').strip()
        try: return float(s)
        except: return default

    def _parse_cm(val, default_mm=37):
        if val is None: return default_mm
        s = str(val).replace('cm', '').replace('mm', '').strip()
        try:
            v = float(s)
            return v * 10 if 'cm' in str(val) else v
        except: return default_mm

    def _parse_indent(val, base_pt=16):
        if val is None: return None
        s = str(val)
        if 'em' in s:
            try: return float(s.replace('em', '').strip()) * base_pt
            except: return None
        return _parse_pt(val, None)

    def _mk_para(text, font=None, size=None, align=None, bold=False, indent=None,
                 line_spacing=None, is_heading=False, heading_level=None, role=None):
        rf = RunFormat(font_name=font, font_size_pt=size, bold=bold or None)
        pf = ParagraphFormat(
            alignment=align,
            first_line_indent_pt=indent,
            line_spacing_pt=line_spacing,
            line_spacing_rule='exact' if line_spacing else None,
        )
        return Paragraph(
            index=0, text=text, is_heading=is_heading,
            heading_level=heading_level, role=role,
            runs=[Run(index=0, text=text, format=rf)],
            format=pf,
        )

    body_size = _parse_pt(body_fmt.get('size'), 16)
    body_indent = _parse_indent(body_fmt.get('first_line_indent'), body_size)

    paras = []
    idx = 0

    # 标题
    template_name = rules.get('template_name', template_id)
    paras.append(_mk_para(
        f"关于印发《{template_name}》的通知",
        font=title_fmt.get('font', '方正小标宋简体'),
        size=_parse_pt(title_fmt.get('size'), 22),
        align=title_fmt.get('align', 'center'),
        is_heading=True, heading_level=0, role='title',
    ))
    paras[-1].index = idx; idx += 1

    # 一级标题
    if h1_fmt:
        paras.append(_mk_para(
            "一、总体要求",
            font=h1_fmt.get('font', '黑体'),
            size=_parse_pt(h1_fmt.get('size'), 16),
            align=h1_fmt.get('align', 'left'),
            is_heading=True, heading_level=1,
        ))
        paras[-1].index = idx; idx += 1

    # 正文段落
    sample_body = [
        "为深入贯彻落实上级文件精神，进一步规范工作流程，提高工作效率，确保各项工作任务有序推进，结合实际情况，特制定本方案。",
        "各单位要高度重视，认真组织实施，确保各项工作要求落到实处。要加强沟通协调，及时反馈工作中遇到的问题和困难。",
    ]
    for text in sample_body:
        paras.append(_mk_para(
            text,
            font=body_fmt.get('font', '仿宋_GB2312'),
            size=body_size,
            align=body_fmt.get('align', 'justify'),
            indent=body_indent,
            line_spacing=_parse_pt(body_fmt.get('line_spacing'), 28.95),
            role='body',
        ))
        paras[-1].index = idx; idx += 1

    # 二级标题
    if h2_fmt:
        paras.append(_mk_para(
            "（一）加强组织领导",
            font=h2_fmt.get('font', '楷体_GB2312'),
            size=_parse_pt(h2_fmt.get('size'), 16),
            align=h2_fmt.get('align'),
            is_heading=True, heading_level=2,
        ))
        paras[-1].index = idx; idx += 1
        paras.append(_mk_para(
            "各责任部门要明确专人负责，建立工作台账，定期检查工作进展情况，确保各项措施有效落实。",
            font=body_fmt.get('font', '仿宋_GB2312'), size=body_size,
            align=body_fmt.get('align', 'justify'), indent=body_indent,
            line_spacing=_parse_pt(body_fmt.get('line_spacing'), 28.95), role='body',
        ))
        paras[-1].index = idx; idx += 1

    # 三级标题
    if h3_fmt:
        paras.append(_mk_para(
            "1. 明确责任分工",
            font=h3_fmt.get('font', '仿宋_GB2312'),
            size=_parse_pt(h3_fmt.get('size'), 16),
            bold=h3_fmt.get('bold', True),
            is_heading=True, heading_level=3,
        ))
        paras[-1].index = idx; idx += 1

    # 落款 + 日期
    paras.append(_mk_para(
        rules.get('template_name', 'XX单位'),
        font=sig_fmt.get('font', '仿宋_GB2312'), size=_parse_pt(sig_fmt.get('size'), 16),
        align=sig_fmt.get('align', 'right'), role='signature',
    ))
    paras[-1].index = idx; idx += 1
    paras.append(_mk_para(
        "2026年06月25日",
        font=date_fmt.get('font', '仿宋_GB2312'), size=_parse_pt(date_fmt.get('size'), 16),
        align=date_fmt.get('align', 'right'), role='date',
    ))
    paras[-1].index = idx; idx += 1

    # 组装预览数据
    paragraphs_data = []
    for p in paras:
        rf = p.runs[0].format if p.runs else RunFormat()
        paragraphs_data.append({
            "text": p.text,
            "role": p.role,
            "is_heading": p.is_heading,
            "heading_level": p.heading_level,
            "format": {
                "alignment": p.format.alignment,
                "first_line_indent_pt": p.format.first_line_indent_pt,
                "font_name": rf.font_name,
                "font_size_pt": rf.font_size_pt,
                "line_spacing_pt": p.format.line_spacing_pt,
            },
        })

    return {
        "paragraphs": paragraphs_data,
        "page_setup": {
            "margin_top_mm": _parse_cm(margins.get('top'), 37),
            "margin_bottom_mm": _parse_cm(margins.get('bottom'), 35),
            "margin_left_mm": _parse_cm(margins.get('left'), 28),
            "margin_right_mm": _parse_cm(margins.get('right'), 26),
        },
    }


@router.post("/save-extracted")
async def save_extracted_template(body: SaveExtractedRequest):
    """保存从文档提取的规则模板。"""
    from config import CUSTOM_RULES_DIR, USER_RULES_DIR
    from core.rules.manager import validate_rule, save_rule

    # 校验文档类型标识
    doc_type = body.document_type.strip()
    if not doc_type or not doc_type.replace('_', '').replace('-', '').isalnum():
        raise HTTPException(status_code=400, detail="文档类型标识只能包含字母、数字、下划线和连字符")

    # 校验规则结构
    try:
        validate_rule(body.yaml_content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"规则格式无效: {str(e)}")

    # 确保 template_name 同步
    body.yaml_content['template_name'] = body.template_name
    body.yaml_content['document_type'] = doc_type

    # 保存到 USER_RULES_DIR（用户规则目录）
    USER_RULES_DIR.mkdir(parents=True, exist_ok=True)
    file_path = USER_RULES_DIR / f"{doc_type}.yaml"

    try:
        with open(file_path, 'w', encoding='utf-8') as f:
            yaml.dump(body.yaml_content, f, allow_unicode=True, default_flow_style=False)
        logger.info(f"Extracted template saved: {file_path}")
    except Exception as e:
        logger.error(f"Failed to save extracted template: {e}")
        raise HTTPException(status_code=500, detail=f"保存失败: {str(e)}")

    # 清除规则缓存
    import services.document_service as svc
    svc.clear_rule_cache()

    return {
        "success": True,
        "document_type": doc_type,
        "file_path": str(file_path),
        "message": f"模板 '{body.template_name}' 已保存为自定义规则",
    }


# ---------------------------------------------------------------------------
#  样式模板中心 API（templates/official/ 体系）
# ---------------------------------------------------------------------------

@router.get("/styles/list")
async def list_style_templates(source: StyleReadSource = Query("all")):
    """列出所有样式模板。"""
    _require_style_read_source(source)
    from core.template.style_manager import list_templates
    templates = list_templates(source)
    return {"templates": templates, "total": len(templates)}


@router.get("/styles/{template_id}")
async def get_style_template(template_id: str, source: StyleReadSource = Query("all")):
    """获取单个样式模板详情。"""
    template_id = _safe_simple_id(template_id, "template_id")
    _require_style_read_source(source)
    from core.template.style_manager import get_template
    template = get_template(template_id, source)
    if not template:
        raise HTTPException(status_code=404, detail=f"Style template not found: {template_id}")
    return template


@router.get("/styles/{template_id}/download/docx")
async def download_style_template_docx(template_id: str):
    """下载样式模板 .docx 文件。"""
    template_id = _safe_simple_id(template_id, "template_id")
    from core.template.generator import generate_docx_template
    output_dir = _GENERATED_TEMPLATES_DIR
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{template_id}_style.docx"

    try:
        generate_docx_template(template_id, output_path)
        # Get template name for the download filename
        from core.template.style_manager import get_template
        tmpl = get_template(template_id)
        name = tmpl.get("name", template_id) if tmpl else template_id

        return FileResponse(
            path=str(output_path),
            filename=f"{name}_样式模板.docx",
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
    except Exception as e:
        logger.error(f"Style template download failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/styles/{template_id}/download/dotx")
async def download_style_template_dotx(template_id: str):
    """下载样式模板 .dotx 文件（可安装到 Word/WPS 模板库）。"""
    template_id = _safe_simple_id(template_id, "template_id")
    from core.template.generator import generate_dotx_template
    output_dir = _GENERATED_TEMPLATES_DIR
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"{template_id}_style.dotx"

    try:
        generate_dotx_template(template_id, output_path)
        from core.template.style_manager import get_template
        tmpl = get_template(template_id)
        name = tmpl.get("name", template_id) if tmpl else template_id

        return FileResponse(
            path=str(output_path),
            filename=f"{name}_样式模板.dotx",
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document.template",
        )
    except Exception as e:
        logger.error(f"Dotx template download failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/styles/import")
async def import_style_template(
    template_id: str = Query(...),
    source: StyleWriteSource = Query("user"),
    yaml_text: str = Query(""),
):
    """导入样式模板（从YAML文本）。"""
    template_id = _safe_simple_id(template_id, "template_id")
    _require_style_write_source(source)
    from core.template.style_manager import import_template
    result = import_template(template_id, yaml_text, source)
    if not result.get("success"):
        raise HTTPException(status_code=400, detail=result.get("error", "Import failed"))
    return result


# ---------------------------------------------------------------------------
#  预置 .dotx 模板下载（公文模板/ 体系）
# ---------------------------------------------------------------------------

def _replace_brand_in_dotx(src_path: Path, dst_path: Path) -> None:
    """
    处理 .dotx 文件，将 "小恐龙" 等品牌名替换为 "Jose AI"。
    .dotx 本质是 ZIP（OOXML），遍历内部 XML 文件进行文本替换。
    """
    tmp_dir = tempfile.mkdtemp(prefix="dotx_brand_")
    try:
        # 解压 .dotx
        with zipfile.ZipFile(src_path, 'r') as zf:
            zf.extractall(tmp_dir)

        # 遍历所有 XML 文件，执行文本替换
        replaced_count = 0
        for root, dirs, files in os.walk(tmp_dir):
            for fname in files:
                if fname.endswith(('.xml', '.rels', '.vml')):
                    fpath = os.path.join(root, fname)
                    try:
                        with open(fpath, 'r', encoding='utf-8') as f:
                            content = f.read()
                        original = content
                        for old_text, new_text in _BRAND_REPLACEMENTS:
                            content = content.replace(old_text, new_text)
                        if content != original:
                            replaced_count += 1
                            with open(fpath, 'w', encoding='utf-8') as f:
                                f.write(content)
                    except (UnicodeDecodeError, PermissionError):
                        # 二进制XML或其他编码问题，跳过
                        pass

        # 重新打包为 .dotx
        dst_path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(dst_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for root, dirs, files in os.walk(tmp_dir):
                for fname in files:
                    fpath = os.path.join(root, fname)
                    arcname = os.path.relpath(fpath, tmp_dir)
                    zf.write(fpath, arcname)

        logger.info(f"品牌替换完成: {replaced_count} 个文件已更新 -> {dst_path.name}")
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


@router.get("/official/{template_id}/download/dotx")
async def download_official_dotx(template_id: str):
    """
    下载预置的官方 .dotx 模板文件。
    优先从 公文模板/ 目录读取真实模板（带品牌替换），
    若不存在则回退到样式模板引擎动态生成。
    """
    template_id = _safe_simple_id(template_id, "template_id")
    cn_name = _TEMPLATE_ID_TO_CN.get(template_id, template_id)
    output_dir = _GENERATED_TEMPLATES_DIR / "processed_dotx"
    output_dir.mkdir(parents=True, exist_ok=True)
    cached_path = output_dir / f"{cn_name}.dotx"

    # 1. 优先从 公文模板/ 目录读取真实 .dotx 文件
    source_dotx = TEMPLATES_DOTX_DIR / f"{cn_name}.dotx"
    if source_dotx.exists():
        # 检查缓存：如果缓存文件比源文件新则直接使用
        if cached_path.exists() and cached_path.stat().st_mtime >= source_dotx.stat().st_mtime:
            logger.info(f"使用缓存的 .dotx 模板: {cn_name}")
        else:
            # 执行品牌替换并缓存
            logger.info(f"从公文模板/读取 .dotx 模板: {cn_name}")
            _replace_brand_in_dotx(source_dotx, cached_path)

        return FileResponse(
            path=str(cached_path),
            filename=f"{cn_name}_公文模板.dotx",
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document.template",
        )

    # 2. 回退：动态生成
    try:
        from core.template.generator import generate_dotx_template
        output_path = output_dir / f"{template_id}_generated.dotx"
        generate_dotx_template(template_id, output_path)

        from core.template.style_manager import get_template
        tmpl = get_template(template_id)
        name = tmpl.get("name", template_id) if tmpl else template_id

        return FileResponse(
            path=str(output_path),
            filename=f"{cn_name}_公文模板.dotx",
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document.template",
        )
    except Exception as e:
        logger.error(f"Official .dotx template download failed: {e}")
        raise HTTPException(status_code=404, detail=f"模板 {template_id} 不存在")


# ---------------------------------------------------------------------------
#  通用模板详情（放在最后，避免拦截 /create、/extract 等固定路径）
# ---------------------------------------------------------------------------

@router.get("/{template_id}")
async def get_template(template_id: str):
    """Get template details."""
    from core.rules.manager import load_rules_merged

    try:
        rules = load_rules_merged(template_id)
        return {
            "template_id": template_id,
            "rules": rules,
            "exists": True
        }
    except Exception as e:
        logger.error(f"Get template {template_id} failed: {e}")
        return {
            "template_id": template_id,
            "exists": False,
            "error": str(e)
        }
