from fastapi.testclient import TestClient

from api.routes import templates as template_routes
from core.rules import manager as rule_manager
from core.template import style_manager
from main import app


FUJIAN_TEMPLATE_IDS = [
    "fujian_province",
]


def test_only_fujian_province_template_is_listed_as_regional(monkeypatch, tmp_path):
    monkeypatch.setattr(template_routes, "_HIDDEN_TEMPLATES_FILE", tmp_path / "hidden_templates.json")
    client = TestClient(app)

    response = client.get("/api/templates/list")

    assert response.status_code == 200
    templates = {item["id"]: item for item in response.json()["templates"]}
    listed_fujian_ids = sorted(item["id"] for item in templates.values() if item["id"].startswith("fujian_"))
    assert listed_fujian_ids == FUJIAN_TEMPLATE_IDS
    for template_id in FUJIAN_TEMPLATE_IDS:
        item = templates[template_id]
        assert item["category"] == "regional"
        assert item["source"] == "official"
        assert item["has_rules"] is True
        assert item["rule_file"] == f"{template_id}.yaml"


def test_fujian_rules_inherit_common_format_rules(monkeypatch, tmp_path):
    monkeypatch.setattr(rule_manager, "CUSTOM_RULES_DIR", tmp_path / "custom_rules")
    monkeypatch.setattr(rule_manager, "USER_RULES_DIR", tmp_path / "user_rules")

    for template_id in FUJIAN_TEMPLATE_IDS:
        rules = rule_manager.load_rules_merged(template_id)

        assert rules["document_type"] == template_id
        assert rules["region"]["province"] == "福建省"
        assert rules["check_rules"], template_id
        assert rules["fix_rules"], template_id
        assert rules.get("title") or rules.get("doc_title")
        assert rules.get("body")


def test_fujian_style_templates_load_with_region_and_styles():
    for template_id in FUJIAN_TEMPLATE_IDS:
        template = style_manager.get_template(template_id, "official")

        assert template is not None, template_id
        assert template["region"]["province"] == "福建省"
        assert template["styles"]["title"]["font_east_asia"] == "方正小标宋简体"
        assert template["styles"]["body"]["font_east_asia"] == "仿宋_GB2312"
        assert template["page"]["size"] == "A4"


def test_fujian_dotx_download_falls_back_to_style_generator(monkeypatch, tmp_path):
    monkeypatch.setattr(template_routes, "_GENERATED_TEMPLATES_DIR", tmp_path / "generated_templates")
    client = TestClient(app)

    response = client.get("/api/templates/official/fujian_province/download/dotx")

    assert response.status_code == 200
    assert response.content[:2] == b"PK"
    assert "application/vnd.openxmlformats-officedocument.wordprocessingml.document.template" in response.headers["content-type"]
