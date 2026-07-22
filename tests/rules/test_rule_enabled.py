import asyncio

import pytest
from pydantic import ValidationError

from api.routes import rules as rule_routes
from core.document.models import DocumentModel, Paragraph, Run, RunFormat
from core.rules import manager as rule_manager
from core.rules.engine import RuleEngine


def _rule(rule_id: str) -> dict:
    return {
        "template_name": rule_id,
        "check_rules": [
            {
                "id": f"CHK-{rule_id}",
                "name": rule_id,
                "severity": "P1",
                "field": "body.font",
            }
        ],
        "fix_rules": [
            {
                "id": f"FIX-{rule_id}",
                "action": "set_font",
                "target": "body",
                "value": rule_id,
            }
        ],
    }


@pytest.fixture
def isolated_rule_dirs(tmp_path, monkeypatch):
    official = tmp_path / "official"
    custom = tmp_path / "custom"
    user = tmp_path / "user"
    for directory in (official, custom, user):
        directory.mkdir()
    monkeypatch.setattr(rule_manager, "OFFICIAL_RULES_DIR", official)
    monkeypatch.setattr(rule_manager, "CUSTOM_RULES_DIR", custom)
    monkeypatch.setattr(rule_manager, "USER_RULES_DIR", user)
    return user


def test_toggling_rule_changes_only_target_and_listing_reports_persisted_value(
    isolated_rule_dirs,
):
    rule_a = _rule("A")
    rule_b = _rule("B")
    assert rule_manager.save_rule("a", rule_a, "user")
    assert rule_manager.save_rule("b", rule_b, "user")
    rule_a_bytes = (isolated_rule_dirs / "a.yaml").read_bytes()

    assert rule_manager.set_rule_enabled("b", False, "user")

    assert (isolated_rule_dirs / "a.yaml").read_bytes() == rule_a_bytes
    assert rule_manager.get_rule_content("a", "user")["content"] == rule_a
    assert rule_manager.get_rule_content("b", "user")["content"] == {
        **rule_b,
        "enabled": False,
    }
    listed = {item["key"]: item["enabled"] for item in rule_manager.list_rule_files("user")}
    assert listed == {"a": True, "b": False}


def test_disabled_rule_file_is_excluded_from_executable_merged_rules(isolated_rule_dirs):
    assert rule_manager.save_rule("a", _rule("A"), "user")
    assert rule_manager.save_rule("b", {**_rule("B"), "enabled": False}, "user")

    enabled_rules = rule_manager.load_rules_merged("a")
    disabled_rules = rule_manager.load_rules_merged("b")

    assert [rule["id"] for rule in enabled_rules["check_rules"]] == ["CHK-A"]
    assert [rule["id"] for rule in enabled_rules["fix_rules"]] == ["FIX-A"]
    assert disabled_rules["check_rules"] == []
    assert disabled_rules["fix_rules"] == []

    model = DocumentModel(paragraphs=[
        Paragraph(
            index=0,
            text="body",
            runs=[Run(text="body", format=RunFormat(font_name="unexpected"))],
        )
    ])
    assert [issue.rule_id for issue in RuleEngine().check(model, "a")] == ["CHK-A"]
    assert RuleEngine().check(model, "b") == []


def test_enabled_api_updates_only_requested_rule_and_invalidates_cache(
    isolated_rule_dirs,
    monkeypatch,
):
    assert rule_manager.save_rule("a", _rule("A"), "user")
    assert rule_manager.save_rule("b", _rule("B"), "user")
    rule_a_bytes = (isolated_rule_dirs / "a.yaml").read_bytes()
    invalidations = []
    monkeypatch.setattr(rule_routes, "_invalidate_cache", lambda: invalidations.append(True))

    result = asyncio.run(
        rule_routes.update_rule_enabled(
            "b",
            rule_routes.RuleEnabledUpdateRequest(enabled=False, source_type="user"),
        )
    )

    assert result == {
        "success": True,
        "key": "b",
        "source_type": "user",
        "enabled": False,
    }
    assert (isolated_rule_dirs / "a.yaml").read_bytes() == rule_a_bytes
    assert rule_manager.get_rule_content("b", "user")["content"]["enabled"] is False
    assert invalidations == [True]


def test_enablement_rejects_non_boolean_values(isolated_rule_dirs):
    assert rule_manager.save_rule("a", _rule("A"), "user")

    with pytest.raises(ValueError, match="must be a boolean"):
        rule_manager.set_rule_enabled("a", 0, "user")
    with pytest.raises(ValidationError):
        rule_routes.RuleEnabledUpdateRequest(enabled="false", source_type="user")
    with pytest.raises(ValueError, match="must be a boolean"):
        rule_manager.validate_rule({**_rule("A"), "enabled": "false"})


def test_rule_change_invalidates_document_and_office_engine_caches(monkeypatch):
    from api.routes import office as office_routes

    invalidated = []
    monkeypatch.setattr(
        rule_routes.svc,
        "clear_rule_cache",
        lambda: invalidated.append("document"),
    )
    monkeypatch.setattr(
        office_routes._rule_engine,
        "clear_cache",
        lambda: invalidated.append("office"),
    )

    rule_routes._invalidate_cache()

    assert invalidated == ["document", "office"]
