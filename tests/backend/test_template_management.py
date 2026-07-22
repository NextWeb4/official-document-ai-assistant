import asyncio

import pytest
import yaml
from fastapi import HTTPException

import config
from api.routes import templates as template_routes
from core.rules import manager as rule_manager
from core.template import style_manager
from services import document_service


def _configure_template_layers(tmp_path, monkeypatch):
    rule_dirs = {
        "official": tmp_path / "rules_official",
        "custom": tmp_path / "rules_custom",
        "user": tmp_path / "rules_user",
    }
    style_dirs = {
        "official": tmp_path / "styles_official",
        "custom": tmp_path / "styles_custom",
        "user": tmp_path / "styles_user",
    }
    for directory in (*rule_dirs.values(), *style_dirs.values()):
        directory.mkdir()

    monkeypatch.setattr(rule_manager, "OFFICIAL_RULES_DIR", rule_dirs["official"])
    monkeypatch.setattr(rule_manager, "CUSTOM_RULES_DIR", rule_dirs["custom"])
    monkeypatch.setattr(rule_manager, "USER_RULES_DIR", rule_dirs["user"])
    monkeypatch.setattr(config, "CUSTOM_RULES_DIR", rule_dirs["custom"])
    monkeypatch.setattr(config, "USER_RULES_DIR", rule_dirs["user"])
    for source, directory in style_dirs.items():
        monkeypatch.setitem(style_manager._DIRS, source, directory)
    monkeypatch.setattr(document_service, "clear_rule_cache", lambda: None)
    return rule_dirs, style_dirs


def test_custom_template_round_trips_rules_metadata_and_downloadable_style(tmp_path, monkeypatch):
    rule_dirs, style_dirs = _configure_template_layers(tmp_path, monkeypatch)
    custom_rule = {
        "id": "CHK-CUSTOM-1",
        "name": "正文行距",
        "severity": "P1",
        "field": "body.line_spacing",
        "expected": "30pt",
        "message": "正文应使用30磅行距",
    }
    body = template_routes.TemplateCreate(
        name="内部报告",
        document_type="internal_report",
        description="内部报告格式",
        icon="报",
        custom_rules=[custom_rule],
    )

    result = asyncio.run(template_routes.create_template(body))

    assert result["success"] is True
    rules = yaml.safe_load((rule_dirs["user"] / "internal_report.yaml").read_text(encoding="utf-8"))
    assert rules["description"] == "内部报告格式"
    assert rules["icon"] == "报"
    assert rules["check_rules"] == [custom_rule]
    assert rules["fix_rules"] == [{
        "id": "FIX-EDIT-001",
        "ref_check": "CHK-CUSTOM-1",
        "action": "set_line_spacing",
        "target": "body",
        "value": "30pt",
    }]
    style = yaml.safe_load((style_dirs["user"] / "internal_report.yaml").read_text(encoding="utf-8"))
    assert style["name"] == "内部报告"
    assert style["description"] == "内部报告格式"
    assert style["styles"]["body"]["font_east_asia"] == "仿宋_GB2312"

    listing = asyncio.run(template_routes.list_templates())
    listed = next(item for item in listing["templates"] if item["id"] == "internal_report")
    assert listed["description"] == "内部报告格式"
    assert listed["icon"] == "报"


def test_rule_update_rebuilds_fix_pairing_and_rejects_unsupported_fields(tmp_path, monkeypatch):
    rule_dirs, _style_dirs = _configure_template_layers(tmp_path, monkeypatch)
    (rule_dirs["user"] / "editable.yaml").write_text(
        yaml.safe_dump({
            "template_name": "Editable",
            "document_type": "editable",
            "check_rules": [{
                "id": "CHK-OLD", "name": "Old", "severity": "P1",
                "field": "title.font", "expected": "宋体", "message": "Old",
            }],
            "fix_rules": [{
                "id": "FIX-OLD", "ref_check": "CHK-OLD",
                "action": "set_font", "target": "title", "value": "宋体",
            }],
        }, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    updated_check = {
        "id": "CHK-NEW", "name": "New", "severity": "P0",
        "field": "body.font", "expected": "仿宋_GB2312", "message": "New",
    }

    result = asyncio.run(template_routes.update_template_rules(
        "editable",
        template_routes.TemplateRulesUpdate(check_rules=[updated_check]),
    ))

    assert result["fix_rules_count"] == 1
    saved = yaml.safe_load((rule_dirs["user"] / "editable.yaml").read_text(encoding="utf-8"))
    assert saved["check_rules"] == [updated_check]
    assert saved["fix_rules"][0]["ref_check"] == "CHK-NEW"
    assert saved["fix_rules"][0]["target"] == "body"
    assert "FIX-OLD" not in {fix["id"] for fix in saved["fix_rules"]}

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(template_routes.update_template_rules(
            "editable",
            template_routes.TemplateRulesUpdate(check_rules=[{
                **updated_check,
                "field": "title.color",
            }]),
        ))
    assert exc_info.value.status_code == 400


def test_rule_field_catalog_uses_checker_paths():
    result = asyncio.run(template_routes.list_rule_fields())
    values = {item["value"] for item in result["fields"]}

    assert "page_setup.margins.top" in values
    assert "title.color" not in values
    assert "page.margin_top" not in values
