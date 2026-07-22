# This file is part of the Official Document AI Assistant.
# (c) 2026 Jose AI (https://www.linhut.cn)
# Licensed under the MIT License. See the LICENSE file for details.
"""
Style Manager: 管理样式模板的加载、保存、导入导出。

模板层级（优先级高→低）：
  user    → data/templates/user/
  custom  → data/custom_templates/
  official→ templates/official/
"""
from __future__ import annotations
from pathlib import Path
from typing import Any
import re
import yaml
import shutil

from config import APP_DATA_DIR, BASE_DIR, USER_TEMPLATES_DIR
from utils.logger import logger


# 模板目录
TEMPLATES_DIR = BASE_DIR / "templates"
OFFICIAL_TEMPLATES_DIR = TEMPLATES_DIR / "official"
CUSTOM_TEMPLATES_DIR = APP_DATA_DIR / "custom_templates"

_DIRS = {
    "official": OFFICIAL_TEMPLATES_DIR,
    "custom": CUSTOM_TEMPLATES_DIR,
    "user": USER_TEMPLATES_DIR,
}
_TEMPLATE_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_READ_SOURCES = frozenset({"all", "official", "custom", "user"})
_WRITE_SOURCES = frozenset({"custom", "user"})


def _ensure_dirs():
    for source in _WRITE_SOURCES:
        d = _DIRS[source]
        d.mkdir(parents=True, exist_ok=True)


def _safe_template_id(template_id: str) -> str:
    if not template_id or not _TEMPLATE_ID_RE.fullmatch(template_id):
        raise ValueError("Template id may only contain letters, numbers, underscores, and hyphens")
    return template_id


def _template_path(dir_path: Path, template_id: str) -> Path:
    return dir_path / f"{_safe_template_id(template_id)}.yaml"


def _validate_read_source(source: str) -> None:
    if source not in _READ_SOURCES:
        raise ValueError("Template read source must be all, official, custom, or user")


def _write_template_dir(source: str) -> Path | None:
    if source in _WRITE_SOURCES:
        return _DIRS[source]
    logger.warning(f"Refusing to write template source: {source}")
    return None


def list_templates(source: str = "all") -> list[dict]:
    """
    列出所有模板。

    Args:
        source: 筛选来源 "all" | "official" | "custom" | "user"

    Returns:
        模板信息列表
    """
    _validate_read_source(source)
    _ensure_dirs()
    results = []
    sources = ["official", "custom", "user"] if source == "all" else [source]

    for src in sources:
        d = _DIRS[src]
        for f in sorted(d.glob("*.yaml")):
            if f.stem.startswith("_"):
                continue
            data = _load_yaml(f)
            results.append({
                "id": f.stem,
                "name": data.get("name", f.stem),
                "type": data.get("type", "unknown"),
                "version": data.get("version", "1.0"),
                "author": data.get("author", src),
                "source": src,
                "standard": data.get("standard", ""),
                "path": str(f),
                "has_styles": "styles" in data,
                "has_page": "page" in data,
            })

    return results


def get_template(template_id: str, source: str = "all") -> dict | None:
    """
    获取单个模板的完整内容。

    Args:
        template_id: 模板 ID（如 "notice"）
        source: 来源筛选

    Returns:
        模板内容 dict，含 _source 字段
    """
    _validate_read_source(source)
    _ensure_dirs()
    try:
        safe_id = _safe_template_id(template_id)
    except ValueError:
        return None

    if source == "all":
        for src in ("user", "custom", "official"):
            f = _template_path(_DIRS[src], safe_id)
            if f.exists():
                data = _load_yaml(f)
                data["_source"] = src
                data["_path"] = str(f)
                return data
        return None

    d = _DIRS.get(source)
    if d is None:
        return None
    f = _template_path(d, safe_id)
    if not f.exists():
        return None
    data = _load_yaml(f)
    data["_source"] = source
    data["_path"] = str(f)
    return data


def save_template(template_id: str, content: dict, source: str = "user") -> bool:
    """保存模板到指定层级。"""
    d = _write_template_dir(source)
    if d is None:
        return False
    _ensure_dirs()

    content.pop("_source", None)
    content.pop("_path", None)

    try:
        f = _template_path(d, template_id)
        with open(f, "w", encoding="utf-8") as fp:
            yaml.dump(content, fp, allow_unicode=True, sort_keys=False)
        logger.info(f"Saved template: {template_id} to {source}")
        return True
    except Exception as e:
        logger.error(f"Failed to save template {template_id}: {e}")
        return False


def delete_template(template_id: str, source: str = "user") -> bool:
    """删除模板（仅 user/custom 可删）。"""
    d = _write_template_dir(source)
    if d is None:
        return False

    _ensure_dirs()

    try:
        f = _template_path(d, template_id)
        if not f.exists():
            return False
        f.unlink()
        logger.info(f"Deleted template: {template_id} from {source}")
        return True
    except Exception as e:
        logger.error(f"Failed to delete template {template_id}: {e}")
        return False


def import_template(template_id: str, yaml_text: str, source: str = "user") -> dict:
    """从 YAML 文本导入模板。"""
    try:
        if source not in _WRITE_SOURCES:
            raise ValueError("Template write source must be custom or user")
        data = yaml.safe_load(yaml_text)
        if not isinstance(data, dict):
            return {"success": False, "error": "Invalid YAML: must be a mapping"}
        ok = save_template(template_id, data, source)
        return {"success": ok, "template_id": template_id, "source": source}
    except (ValueError, yaml.YAMLError) as e:
        return {"success": False, "error": str(e)}


def export_template(template_id: str, source: str = "all") -> str | None:
    """导出模板为 YAML 文本。"""
    data = get_template(template_id, source)
    if not data:
        return None
    data.pop("_source", None)
    data.pop("_path", None)
    return yaml.dump(data, allow_unicode=True, sort_keys=False)


def get_style_for_type(template_id: str) -> dict[str, dict]:
    """
    获取指定模板类型的样式配置。
    返回 {title: {...}, body: {...}, subtitle: {...}, ...} 格式。
    """
    template = get_template(template_id)
    if not template:
        return {}
    return template.get("styles", {})


def get_page_setup(template_id: str) -> dict:
    """获取指定模板的页面设置。"""
    template = get_template(template_id)
    if not template:
        return {}
    return template.get("page", {})


def _load_yaml(path: Path) -> dict:
    """加载 YAML 文件。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
        return data if isinstance(data, dict) else {}
    except Exception as e:
        logger.warning(f"Failed to load template {path}: {e}")
        return {}
