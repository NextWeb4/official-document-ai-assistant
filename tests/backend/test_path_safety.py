import asyncio

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from api.routes import office as office_routes
from api.routes import templates as template_routes
from api.routes import rules as rule_routes
from core.rules import manager as rule_manager
from core.template import style_manager
import services.document_service as document_service


VALID_RULE = {
    "title": {"font": "Test"},
    "check_rules": [{"id": "CHK001", "severity": "P1"}],
    "fix_rules": [{"action": "set_font"}],
}


def test_rule_manager_rejects_path_traversal_keys(tmp_path, monkeypatch):
    outside = tmp_path / "escape.yaml"
    outside.write_text("title:\n  font: secret\n", encoding="utf-8")

    monkeypatch.setattr(rule_manager, "OFFICIAL_RULES_DIR", tmp_path / "official")
    monkeypatch.setattr(rule_manager, "CUSTOM_RULES_DIR", tmp_path / "custom")
    monkeypatch.setattr(rule_manager, "USER_RULES_DIR", tmp_path / "user")

    assert rule_manager.get_rule_content("../escape") is None
    assert not rule_manager.save_rule("../escape", VALID_RULE)
    assert not rule_manager.delete_rule("../escape")
    assert outside.exists()

    merged = rule_manager.load_rules_merged("../escape")
    assert merged.get("title") is None


def test_style_manager_rejects_path_traversal_template_ids(tmp_path, monkeypatch):
    outside = tmp_path / "escape.yaml"
    outside.write_text("name: secret\n", encoding="utf-8")

    monkeypatch.setitem(style_manager._DIRS, "official", tmp_path / "official")
    monkeypatch.setitem(style_manager._DIRS, "custom", tmp_path / "custom")
    monkeypatch.setitem(style_manager._DIRS, "user", tmp_path / "user")

    assert style_manager.get_template("../escape") is None
    assert not style_manager.save_template("../escape", {"name": "bad"})
    assert not style_manager.delete_template("../escape")
    assert outside.exists()


async def test_create_template_rejects_path_document_type():
    body = template_routes.TemplateCreate(
        name="bad",
        document_type="../escape",
        description="bad",
    )

    with pytest.raises(HTTPException) as exc:
        await template_routes.create_template(body)

    assert exc.value.status_code == 400


def test_rule_delete_rejects_official_source():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(rule_routes.remove_rule("notice", source_type="official"))

    assert exc.value.status_code == 403


def test_template_delete_hides_official_source(tmp_path, monkeypatch):
    hidden_file = tmp_path / "hidden_templates.json"
    monkeypatch.setattr(template_routes, "_HIDDEN_TEMPLATES_FILE", hidden_file)

    result = asyncio.run(template_routes.delete_template("notice", source_type="official"))

    assert result["success"] is True
    assert result["action"] == "hidden"
    assert template_routes._load_hidden_template_ids() == {"notice"}

    restore = asyncio.run(template_routes.restore_deleted_templates())

    assert restore["restored"] == 1
    assert template_routes._load_hidden_template_ids() == set()


def test_template_delete_removes_user_rule_file(tmp_path, monkeypatch):
    user_dir = tmp_path / "user_rules"
    custom_dir = tmp_path / "custom_rules"
    official_dir = tmp_path / "official_rules"
    user_dir.mkdir()
    rule_file = user_dir / "my_template.yaml"
    rule_file.write_text("title:\n  font: Test\n", encoding="utf-8")

    monkeypatch.setattr(rule_manager, "USER_RULES_DIR", user_dir)
    monkeypatch.setattr(rule_manager, "CUSTOM_RULES_DIR", custom_dir)
    monkeypatch.setattr(rule_manager, "OFFICIAL_RULES_DIR", official_dir)
    monkeypatch.setattr(document_service, "clear_rule_cache", lambda: None)

    result = asyncio.run(template_routes.delete_template("my_template", source_type="user"))

    assert result["success"] is True
    assert result["template_id"] == "my_template"
    assert not rule_file.exists()


def test_template_delete_removes_matching_user_style(tmp_path, monkeypatch):
    from core.template import style_manager

    user_rules = tmp_path / "user_rules"
    custom_rules = tmp_path / "custom_rules"
    official_rules = tmp_path / "official_rules"
    user_styles = tmp_path / "user_styles"
    custom_styles = tmp_path / "custom_styles"
    official_styles = tmp_path / "official_styles"
    for directory in (
        user_rules, custom_rules, official_rules,
        user_styles, custom_styles, official_styles,
    ):
        directory.mkdir()

    (user_rules / "duplicated.yaml").write_text(
        "template_name: duplicated\ndocument_type: notice\n",
        encoding="utf-8",
    )
    (user_styles / "duplicated.yaml").write_text(
        "id: duplicated\nname: duplicated\nstyles: {}\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(rule_manager, "USER_RULES_DIR", user_rules)
    monkeypatch.setattr(rule_manager, "CUSTOM_RULES_DIR", custom_rules)
    monkeypatch.setattr(rule_manager, "OFFICIAL_RULES_DIR", official_rules)
    monkeypatch.setitem(style_manager._DIRS, "user", user_styles)
    monkeypatch.setitem(style_manager._DIRS, "custom", custom_styles)
    monkeypatch.setitem(style_manager._DIRS, "official", official_styles)
    monkeypatch.setattr(document_service, "clear_rule_cache", lambda: None)

    result = asyncio.run(template_routes.delete_template("duplicated", source_type="user"))

    assert result["success"] is True
    assert not (user_rules / "duplicated.yaml").exists()
    assert not (user_styles / "duplicated.yaml").exists()


def test_template_rule_update_writes_user_override_and_replaces_check_rules(tmp_path, monkeypatch):
    official_dir = tmp_path / "official_rules"
    custom_dir = tmp_path / "custom_rules"
    user_dir = tmp_path / "user_rules"
    official_dir.mkdir()
    official_rule = official_dir / "notice.yaml"
    official_rule.write_text(
        """
template_name: 通知
document_type: notice
title:
  font: Original
check_rules:
  - id: CHK-OLD-1
    name: Old One
    severity: P1
    field: title.font
  - id: CHK-OLD-2
    name: Old Two
    severity: P1
    field: body.font
fix_rules:
  - action: set_font
""",
        encoding="utf-8",
    )

    monkeypatch.setattr(rule_manager, "OFFICIAL_RULES_DIR", official_dir)
    monkeypatch.setattr(rule_manager, "CUSTOM_RULES_DIR", custom_dir)
    monkeypatch.setattr(rule_manager, "USER_RULES_DIR", user_dir)
    monkeypatch.setattr(document_service, "clear_rule_cache", lambda: None)

    body = template_routes.TemplateRulesUpdate(check_rules=[
        {
            "id": "CHK-NEW-1",
            "name": "New One",
            "severity": "P0",
            "field": "title.font",
            "expected": "New Font",
            "message": "Use New Font",
        }
    ])

    result = asyncio.run(template_routes.update_template_rules("notice", body))
    merged = rule_manager.load_rules_merged("notice")

    assert result["success"] is True
    assert (user_dir / "notice.yaml").exists()
    assert [rule["id"] for rule in merged["check_rules"]] == ["CHK-NEW-1"]
    assert merged["title"]["font"] == "Original"


def test_duplicate_official_template_writes_user_copy_without_mutating_official(tmp_path, monkeypatch):
    official_dir = tmp_path / "official_rules"
    custom_dir = tmp_path / "custom_rules"
    user_dir = tmp_path / "user_rules"
    official_dir.mkdir()
    official_rule = official_dir / "notice.yaml"
    official_rule.write_text(
        """
template_name: 通知
document_type: notice
title:
  font: Original
check_rules:
  - id: CHK-OLD-1
    name: Old One
    severity: P1
    field: title.font
fix_rules:
  - action: set_font
""",
        encoding="utf-8",
    )

    official_templates = tmp_path / "official_templates"
    custom_templates = tmp_path / "custom_templates"
    user_templates = tmp_path / "user_templates"
    official_templates.mkdir()
    (official_templates / "notice.yaml").write_text(
        """
name: 通知
type: document
styles: {}
page: {}
""",
        encoding="utf-8",
    )

    monkeypatch.setattr(rule_manager, "OFFICIAL_RULES_DIR", official_dir)
    monkeypatch.setattr(rule_manager, "CUSTOM_RULES_DIR", custom_dir)
    monkeypatch.setattr(rule_manager, "USER_RULES_DIR", user_dir)
    monkeypatch.setitem(style_manager._DIRS, "official", official_templates)
    monkeypatch.setitem(style_manager._DIRS, "custom", custom_templates)
    monkeypatch.setitem(style_manager._DIRS, "user", user_templates)
    monkeypatch.setattr(document_service, "clear_rule_cache", lambda: None)

    result = asyncio.run(template_routes.duplicate_template("notice"))
    copied_rule = user_dir / "notice_copy.yaml"
    copied_style = user_templates / "notice_copy.yaml"

    assert result["success"] is True
    assert result["template_id"] == "notice_copy"
    assert result["source_type"] == "user"
    assert result["copied_style"] is True
    assert copied_rule.exists()
    assert copied_style.exists()
    assert official_rule.read_text(encoding="utf-8").count("document_type: notice") == 1

    merged = rule_manager.load_rules_merged("notice_copy")
    assert merged["document_type"] == "notice_copy"
    assert merged["template_name"] == "通知 副本"
    assert [rule["id"] for rule in merged["check_rules"]] == ["CHK-OLD-1"]
    assert style_manager.get_template("notice_copy", "user")["name"] == "通知 副本"


@pytest.mark.parametrize("source_type", ["official", "all", "unknown"])
def test_rule_manager_rejects_non_writable_sources(tmp_path, monkeypatch, source_type):
    monkeypatch.setattr(rule_manager, "OFFICIAL_RULES_DIR", tmp_path / "official")
    monkeypatch.setattr(rule_manager, "CUSTOM_RULES_DIR", tmp_path / "custom")
    monkeypatch.setattr(rule_manager, "USER_RULES_DIR", tmp_path / "user")

    assert rule_manager.save_rule("blocked", VALID_RULE, source_type) is False
    result = rule_manager.import_rule("blocked", "title:\n  font: Test\n", source_type)

    assert result["success"] is False
    assert not list(tmp_path.rglob("blocked.yaml"))


def test_rule_api_models_reject_non_writable_sources():
    with pytest.raises(ValidationError):
        rule_routes.RuleUpdateRequest(content=VALID_RULE, source_type="official")

    with pytest.raises(ValidationError):
        rule_routes.RuleImportRequest(
            key="blocked",
            yaml_text="title:\n  font: Test\n",
            source_type="unknown",
        )


def test_rule_manager_and_api_reject_unknown_read_source():
    with pytest.raises(ValueError, match="read source_type"):
        rule_manager.list_rule_files("unknown")

    with pytest.raises(ValueError, match="read source_type"):
        rule_manager.get_rule_content("notice", "unknown")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(rule_routes.list_rules("unknown"))
    assert exc.value.status_code == 400


@pytest.mark.parametrize("source", ["official", "all", "unknown"])
def test_style_manager_rejects_non_writable_sources(tmp_path, monkeypatch, source):
    official_dir = tmp_path / "official"
    custom_dir = tmp_path / "custom"
    user_dir = tmp_path / "user"
    official_dir.mkdir()
    official_file = official_dir / "blocked.yaml"
    official_file.write_text("name: Official\n", encoding="utf-8")

    monkeypatch.setitem(style_manager._DIRS, "official", official_dir)
    monkeypatch.setitem(style_manager._DIRS, "custom", custom_dir)
    monkeypatch.setitem(style_manager._DIRS, "user", user_dir)

    content = {"name": "Blocked", "_source": "unchanged"}
    assert style_manager.save_template("blocked", content, source) is False
    result = style_manager.import_template("blocked", "name: Blocked\n", source)

    assert result["success"] is False
    assert content["_source"] == "unchanged"
    assert official_file.read_text(encoding="utf-8") == "name: Official\n"
    assert not (custom_dir / "blocked.yaml").exists()
    assert not (user_dir / "blocked.yaml").exists()


def test_style_manager_and_api_reject_unknown_read_source():
    with pytest.raises(ValueError, match="read source"):
        style_manager.list_templates("unknown")

    with pytest.raises(ValueError, match="read source"):
        style_manager.get_template("notice", "unknown")

    with pytest.raises(HTTPException) as exc:
        asyncio.run(template_routes.list_style_templates("unknown"))
    assert exc.value.status_code == 400


@pytest.mark.parametrize(
    ("source", "expected_status"),
    [("official", 403), ("all", 400), ("unknown", 400)],
)
def test_style_import_api_rejects_non_writable_sources(
    tmp_path,
    monkeypatch,
    source,
    expected_status,
):
    official_dir = tmp_path / "official"
    custom_dir = tmp_path / "custom"
    user_dir = tmp_path / "user"
    monkeypatch.setitem(style_manager._DIRS, "official", official_dir)
    monkeypatch.setitem(style_manager._DIRS, "custom", custom_dir)
    monkeypatch.setitem(style_manager._DIRS, "user", user_dir)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(template_routes.import_style_template(
            template_id="blocked",
            source=source,
            yaml_text="name: Blocked\n",
        ))

    assert exc.value.status_code == expected_status
    assert not list(tmp_path.rglob("blocked.yaml"))


def test_office_generate_template_rejects_traversal_before_writing(tmp_path, monkeypatch):
    bridge_dir = tmp_path / "bridge"
    monkeypatch.setattr(office_routes, "_BRIDGE_TMP", bridge_dir)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(office_routes.office_generate_template("../escape", "docx"))

    assert exc.value.status_code == 400
    assert not bridge_dir.exists()
    assert not (tmp_path / "escape_template.docx").exists()


@pytest.mark.parametrize("output_format", ["pdf", "DOCX", "docx ", ""])
def test_office_generate_template_rejects_invalid_format_before_writing(
    tmp_path,
    monkeypatch,
    output_format,
):
    bridge_dir = tmp_path / "bridge"
    monkeypatch.setattr(office_routes, "_BRIDGE_TMP", bridge_dir)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(office_routes.office_generate_template("notice", output_format))

    assert exc.value.status_code == 400
    assert not bridge_dir.exists()
