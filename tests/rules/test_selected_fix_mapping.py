from core.document.models import DocumentModel, Paragraph, Run, RunFormat
from core.rules.fixer import apply_fixes_with_count


def _model() -> DocumentModel:
    return DocumentModel(paragraphs=[
        Paragraph(
            index=0,
            text="正文",
            role="body",
            runs=[Run(index=0, text="正文", format=RunFormat(font_name="错误字体"))],
        )
    ])


def test_selected_check_rule_id_applies_fix_linked_by_ref_check():
    rules = {
        "fix_rules": [{
            "id": "FIX-001",
            "ref_check": "CHK-001",
            "action": "set_font",
            "target": "body",
            "value": "仿宋_GB2312",
        }]
    }

    fixed, applied = apply_fixes_with_count(_model(), rules, ["CHK-001"])

    assert applied == 1
    assert fixed.paragraphs[0].runs[0].format.font_name == "仿宋_GB2312"


def test_selected_fix_rule_id_remains_supported_and_unknown_id_is_noop():
    rules = {
        "fix_rules": [{
            "id": "FIX-001",
            "ref_check": "CHK-001",
            "action": "set_font",
            "target": "body",
            "value": "仿宋_GB2312",
        }]
    }

    fixed_by_id, applied_by_id = apply_fixes_with_count(_model(), rules, ["FIX-001"])
    unchanged, applied_unknown = apply_fixes_with_count(_model(), rules, ["CHK-UNKNOWN"])

    assert applied_by_id == 1
    assert fixed_by_id.paragraphs[0].runs[0].format.font_name == "仿宋_GB2312"
    assert applied_unknown == 0
    assert unchanged.paragraphs[0].runs[0].format.font_name == "错误字体"
