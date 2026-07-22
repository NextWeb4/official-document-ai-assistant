# This file is part of the Official Document AI Assistant.
# (c) 2026 Jose AI (https://www.linhut.cn)
# Licensed under the MIT License. See the LICENSE file for details.
"""
Rule Manager: unified rule loading with priority layering.

Priority: user > custom > official
"""
from __future__ import annotations
import copy
import json
import re
import yaml
from pathlib import Path
from typing import Any

from config import RULES_DIR, CUSTOM_RULES_DIR, USER_RULES_DIR
from utils.logger import logger

# Rule source directories
OFFICIAL_RULES_DIR = RULES_DIR  # rules/official（只读，捆绑在安装目录）
_RULE_KEY_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_READ_SOURCE_TYPES = frozenset({"all", "official", "custom", "user"})
_WRITE_SOURCE_TYPES = frozenset({"custom", "user"})


def _ensure_dirs() -> None:
    CUSTOM_RULES_DIR.mkdir(parents=True, exist_ok=True)
    USER_RULES_DIR.mkdir(parents=True, exist_ok=True)


def _safe_rule_key(key: str) -> str:
    if not key or not _RULE_KEY_RE.fullmatch(key):
        raise ValueError("Rule key may only contain letters, numbers, underscores, and hyphens")
    return key


def _rule_path(dir_path: Path, key: str) -> Path:
    return dir_path / f"{_safe_rule_key(key)}.yaml"


def _validate_read_source(source_type: str) -> None:
    if source_type not in _READ_SOURCE_TYPES:
        raise ValueError("Rule read source_type must be all, official, custom, or user")


def _write_rule_dir(source_type: str) -> Path | None:
    if source_type == "custom":
        return CUSTOM_RULES_DIR
    if source_type == "user":
        return USER_RULES_DIR
    logger.warning(f"Refusing to write rule source: {source_type}")
    return None


def _rule_is_enabled(content: dict[str, Any]) -> bool:
    """Return the persisted file-level enabled flag, defaulting to enabled."""
    enabled = content.get("enabled", True)
    return enabled if isinstance(enabled, bool) else True


def list_rule_files(source: str = "all") -> list[dict]:
    """List rule files from given source: official, custom, user, all."""
    _validate_read_source(source)
    _ensure_dirs()
    result = []
    dirs = {
        "official": OFFICIAL_RULES_DIR,
        "custom": CUSTOM_RULES_DIR,
        "user": USER_RULES_DIR,
    }
    for source_type, d in dirs.items():
        if source != "all" and source != source_type:
            continue
        for f in sorted(d.glob("*.yaml")):
            if f.stem.startswith("_"):
                continue
            content = _load_yaml(f)
            result.append({
                "key": f.stem,
                "name": f.stem,
                "source_type": source_type,
                "path": str(f),
                "size": f.stat().st_size,
                "enabled": _rule_is_enabled(content),
            })
    return result


def load_rules_merged(doc_type: str = "") -> dict[str, Any]:
    """
    Load and merge rules for a document type with priority:
    official < custom < user
    """
    _ensure_dirs()
    merged: dict[str, Any] = {}

    layers = [
        ("official", OFFICIAL_RULES_DIR),
        ("custom", CUSTOM_RULES_DIR),
        ("user", USER_RULES_DIR),
    ]
    for _source, dir_path in layers:
        # Load common
        common_file = dir_path / "_common.yaml"
        if common_file.exists():
            _merge_rule_file(merged, common_file)

        # Load type-specific
        if doc_type:
            try:
                type_file = _rule_path(dir_path, doc_type)
            except ValueError:
                logger.warning(f"Ignoring invalid rule type: {doc_type}")
                type_file = None
            if type_file and type_file.exists():
                _merge_rule_file(merged, type_file)

    # Merge fix_rules and check_rules as distinct lists, not overwritten
    merged.setdefault("fix_rules", [])
    merged.setdefault("check_rules", [])
    _normalize_rule_aliases(merged)
    merged.pop("__replace_check_rules", None)
    merged.pop("__replace_fix_rules", None)
    return merged


def _load_yaml(path: Path) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return yaml.safe_load(fh) or {}
    except Exception as exc:
        logger.error(f"Failed to load rule {path}: {exc}")
        return {}


def _merge_rule_file(merged: dict[str, Any], path: Path) -> None:
    content = _load_yaml(path)
    if not _rule_is_enabled(content):
        logger.info(f"Skipped disabled rule: {path}")
        return
    _deep_merge(merged, content)


def _deep_merge(base: dict, overlay: dict) -> None:
    """Merge overlay into base in-place, with deduplication for fix_rules/check_rules."""
    for key, val in overlay.items():
        if key in ("fix_rules", "check_rules") and isinstance(val, list):
            if overlay.get(f"__replace_{key}") is True:
                base[key] = copy.deepcopy(val)
                continue
            existing = base.setdefault(key, [])
            if key == "check_rules":
                _dedup_extend(existing, val, dedup_key=lambda r: r.get("field"))
            elif key == "fix_rules":
                _dedup_extend(existing, val, dedup_key=lambda r: (r.get("target"), r.get("action")))
        elif key in base and isinstance(base[key], dict) and isinstance(val, dict):
            _deep_merge(base[key], val)
        else:
            base[key] = copy.deepcopy(val)


def _dedup_extend(base_list: list, new_items: list, dedup_key) -> None:
    """Extend base_list with new_items, replacing duplicates by dedup_key."""
    existing_keys = {dedup_key(item) for item in base_list if dedup_key(item) is not None}
    # First add items whose key is already in base (override)
    for item in new_items:
        k = dedup_key(item)
        if k is not None and k in existing_keys:
            # Replace existing item with same key
            for i, existing in enumerate(base_list):
                if dedup_key(existing) == k:
                    base_list[i] = copy.deepcopy(item)
                    break
    # Then add truly new items
    for item in new_items:
        k = dedup_key(item)
        if k is None or k not in existing_keys:
            base_list.append(copy.deepcopy(item))
            if k is not None:
                existing_keys.add(k)


def _normalize_rule_aliases(rule: dict[str, Any]) -> None:
    """Keep legacy rule field names and current checker paths in sync."""
    if "doc_title" in rule and "title" not in rule:
        rule["title"] = copy.deepcopy(rule["doc_title"])
    elif "title" in rule and "doc_title" not in rule:
        rule["doc_title"] = copy.deepcopy(rule["title"])


def save_rule(key: str, content: dict, source_type: str = "user") -> bool:
    """Save a user/custom rule YAML file."""
    dir_path = _write_rule_dir(source_type)
    if dir_path is None:
        return False
    _ensure_dirs()
    try:
        file_path = _rule_path(dir_path, key)
        with open(file_path, "w", encoding="utf-8") as fh:
            yaml.dump(content, fh, allow_unicode=True, default_flow_style=False)
        logger.info(f"Rule saved: {file_path}")
        return True
    except Exception as exc:
        logger.error(f"Failed to save rule {key}: {exc}")
        return False


def set_rule_enabled(key: str, enabled: bool, source_type: str = "user") -> bool:
    """Update only a writable rule file's persisted enabled flag."""
    if not isinstance(enabled, bool):
        raise ValueError("Rule enabled value must be a boolean")
    dir_path = _write_rule_dir(source_type)
    if dir_path is None:
        return False
    _ensure_dirs()
    try:
        file_path = _rule_path(dir_path, key)
        if not file_path.exists():
            return False
        content = _load_yaml(file_path)
        if not content:
            logger.error(f"Cannot toggle empty or invalid rule: {file_path}")
            return False
        content["enabled"] = enabled
        return save_rule(key, content, source_type)
    except Exception as exc:
        logger.error(f"Failed to update rule state {key}: {exc}")
        return False


def delete_rule(key: str, source_type: str = "user") -> bool:
    """Delete a user/custom rule YAML file."""
    dir_path = _write_rule_dir(source_type)
    if dir_path is None:
        return False
    _ensure_dirs()
    try:
        file_path = _rule_path(dir_path, key)
        if file_path.exists():
            file_path.unlink()
            logger.info(f"Rule deleted: {file_path}")
            return True
        return False
    except Exception as exc:
        logger.error(f"Failed to delete rule {key}: {exc}")
        return False


def get_rule_content(key: str, source_type: str = "all") -> dict | None:
    """Get full content of a rule by key."""
    _validate_read_source(source_type)
    _ensure_dirs()
    try:
        safe_key = _safe_rule_key(key)
    except ValueError:
        return None
    dirs = {
        "official": OFFICIAL_RULES_DIR,
        "custom": CUSTOM_RULES_DIR,
        "user": USER_RULES_DIR,
    }
    for st, d in dirs.items():
        if source_type != "all" and source_type != st:
            continue
        f = d / f"{safe_key}.yaml"
        if f.exists():
            return {
                "key": safe_key,
                "source_type": st,
                "content": _load_yaml(f),
                "path": str(f),
            }
    return None


def export_rule(key: str, source_type: str = "all") -> str | None:
    """Export a rule as YAML string."""
    rule = get_rule_content(key, source_type)
    if not rule:
        return None
    return yaml.dump(rule["content"], allow_unicode=True, default_flow_style=False)


def import_rule(key: str, yaml_text: str, source_type: str = "user") -> dict:
    """Import a rule from YAML text."""
    try:
        if source_type not in _WRITE_SOURCE_TYPES:
            raise ValueError("Rule write source_type must be custom or user")
        content = yaml.safe_load(yaml_text)
        if not isinstance(content, dict):
            raise ValueError("Invalid YAML: not a dict")
        # Validate basic structure
        validate_rule(content)
        ok = save_rule(key, content, source_type)
        return {"success": ok, "key": key, "source_type": source_type}
    except Exception as exc:
        logger.error(f"Failed to import rule {key}: {exc}")
        return {"success": False, "error": str(exc)}


def validate_rule(rule: dict) -> None:
    """
    Validate rule structure.
    Raises ValueError on failure.
    """
    if not isinstance(rule, dict):
        raise ValueError("Rule must be a dictionary")

    if "enabled" in rule and not isinstance(rule["enabled"], bool):
        raise ValueError("Rule 'enabled' must be a boolean")

    # Must have at least some meaningful content
    has_format = any(k in rule for k in ("title", "body", "page_setup"))
    has_rules = any(k in rule for k in ("check_rules", "fix_rules"))
    if not has_format and not has_rules:
        raise ValueError(
            "Rule must have at least one of: title, body, page_setup, check_rules, fix_rules"
        )

    # Validate check_rules structure
    for cr in rule.get("check_rules", []):
        if not isinstance(cr, dict):
            raise ValueError("Each check_rule must be a dict")
        if "id" not in cr:
            raise ValueError("Each check_rule must have an 'id'")
        if "severity" not in cr:
            raise ValueError(f"check_rule '{cr.get('id', '?')}' must have 'severity'")

    # Validate fix_rules structure
    for fr in rule.get("fix_rules", []):
        if not isinstance(fr, dict):
            raise ValueError("Each fix_rule must be a dict")
        if "action" not in fr:
            raise ValueError(f"Each fix_rule must have an 'action', got: {fr}")

    # Validate check_rules and fix_rules are lists if present
    for field in ("fix_rules", "check_rules"):
        if field in rule and not isinstance(rule[field], list):
            raise ValueError(f"'{field}' must be a list")


def override_priority(source_type: str) -> int:
    """Return override priority: higher value = higher priority."""
    return {"official": 0, "custom": 1, "user": 2}.get(source_type, -1)
