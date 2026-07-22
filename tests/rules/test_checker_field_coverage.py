from pathlib import Path

import yaml

from core.document.models import (
    DocumentModel,
    HeaderFooter,
    PageSetup,
    Paragraph,
    ParagraphFormat,
    Run,
    RunFormat,
)
from core.rules.checker import (
    _EXECUTABLE_CHECK_FIELDS,
    _EXPLICITLY_UNSUPPORTED_OFFICIAL_CHECK_FIELDS,
    check_document,
)


OFFICIAL_RULES_DIR = Path(__file__).parents[2] / "rules" / "official"


def _check_rule(field: str, expected, rule_id: str = "CHK-TEST") -> dict:
    return {
        "check_rules": [{
            "id": rule_id,
            "name": field,
            "severity": "P1",
            "field": field,
            "expected": expected,
            "message": "不符合规则",
        }]
    }


def test_every_shipped_check_field_is_executable_or_explicitly_unsupported():
    shipped_fields = set()
    for path in OFFICIAL_RULES_DIR.glob("*.yaml"):
        content = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        shipped_fields.update(
            rule.get("field", "")
            for rule in content.get("check_rules", [])
        )

    assert not (_EXECUTABLE_CHECK_FIELDS & _EXPLICITLY_UNSUPPORTED_OFFICIAL_CHECK_FIELDS)
    assert shipped_fields <= (
        _EXECUTABLE_CHECK_FIELDS | _EXPLICITLY_UNSUPPORTED_OFFICIAL_CHECK_FIELDS
    )


def test_unknown_and_semantic_only_fields_never_silently_pass():
    model = DocumentModel(paragraphs=[Paragraph(index=0, text="正文", role="body")])

    unknown = check_document(model, _check_rule("content.future_field", "value"))
    semantic = check_document(model, _check_rule("content.facts", "事实准确"))

    assert len(unknown) == 1
    assert unknown[0].check_type == "logic"
    assert "未执行" in unknown[0].reason
    assert len(semantic) == 1
    assert semantic[0].check_type == "logic"
    assert "结构化语义" in semantic[0].reason


def test_title_bold_checks_the_document_model_instead_of_rule_data():
    title = Paragraph(
        index=0,
        text="公文标题",
        role="title",
        runs=[Run(index=0, text="公文标题", format=RunFormat(bold=False))],
    )
    model = DocumentModel(paragraphs=[title])

    assert check_document(model, _check_rule("title.bold", False)) == []
    issues = check_document(model, _check_rule("title.bold", True))

    assert len(issues) == 1
    assert issues[0].rule_id == "CHK-TEST"
    assert issues[0].location == "paragraph:0"


def test_legal_basis_checks_document_text():
    compliant = DocumentModel(paragraphs=[
        Paragraph(index=0, text="根据《中华人民共和国行政许可法》，作出如下决定。", role="body")
    ])
    missing = DocumentModel(paragraphs=[
        Paragraph(index=0, text="现作出如下决定。", role="body")
    ])

    assert check_document(compliant, _check_rule("content.legal_basis", "依据明确")) == []
    issues = check_document(missing, _check_rule("content.legal_basis", "依据明确"))

    assert len(issues) == 1
    assert issues[0].location == "document_body"


def test_page_number_font_and_size_use_page_footer_runs():
    page_run = Run(
        index=0,
        text="1",
        format=RunFormat(font_name="宋体", font_size_pt=14),
    )
    footer = HeaderFooter(
        type="footer",
        has_page_number=True,
        paragraphs=[Paragraph(index=0, text="1", runs=[page_run])],
    )
    model = DocumentModel(footers=[footer])

    rules = {
        "check_rules": [
            {**_check_rule("page_number.font", "宋体", "CHK-FONT")["check_rules"][0]},
            {**_check_rule("page_number.size", "14pt", "CHK-SIZE")["check_rules"][0]},
        ]
    }
    assert check_document(model, rules) == []


def test_missing_numeric_formatting_is_not_treated_as_compliant():
    model = DocumentModel(paragraphs=[
        Paragraph(
            index=0,
            text="标题",
            role="title",
            is_heading=True,
            heading_level=0,
            runs=[Run(index=0, text="标题", format=RunFormat(font_size_pt=None))],
        ),
        Paragraph(
            index=1,
            text="一级标题",
            is_heading=True,
            heading_level=1,
            runs=[Run(index=0, text="一级标题", format=RunFormat(font_size_pt=None))],
            format=ParagraphFormat(first_line_indent_pt=None, line_spacing_pt=None),
        ),
        Paragraph(
            index=2,
            text="正文",
            role="body",
            runs=[Run(index=0, text="正文", format=RunFormat(font_size_pt=None))],
            format=ParagraphFormat(first_line_indent_pt=None, line_spacing_pt=None),
        ),
    ], page_setup=PageSetup(margin_top_mm=None))

    for field, expected in [
        ("title.size", "22pt"),
        ("heading_1.size", "16pt"),
        ("heading_1.first_line_indent", "2em"),
        ("heading_1.line_spacing", "28pt"),
        ("body.size", "16pt"),
        ("body.first_line_indent", "2em"),
        ("body.line_spacing", "28pt"),
        ("page_setup.margins.top", "3.7cm"),
    ]:
        issues = check_document(model, _check_rule(field, expected, field))
        assert any(issue.rule_id == field for issue in issues), field


def test_malformed_numeric_expectation_is_reported_as_rule_configuration_issue():
    model = DocumentModel(paragraphs=[
        Paragraph(
            index=0,
            text="正文",
            role="body",
            runs=[Run(index=0, text="正文", format=RunFormat(font_size_pt=16))],
        )
    ])

    issues = check_document(model, _check_rule("body.size", "大号"))

    assert len(issues) == 1
    assert issues[0].check_type == "logic"
    assert "无法转换" in issues[0].reason
