from core.document.models import DocumentModel, Paragraph, Run, RunFormat
from core.document.modifier import fix_bold_range, normalize_heading_content


def _format(**overrides) -> RunFormat:
    values = {
        "font_name": "方正小标宋简体",
        "latin_font_name": "Arial",
        "font_size_pt": 16,
        "bold": True,
        "italic": True,
        "underline": True,
        "color": "123456",
    }
    values.update(overrides)
    return RunFormat(**values)


def test_fix_bold_range_preserves_every_other_run_format_field():
    text = "重点：" + "后续正文" * 8
    paragraph = Paragraph(
        index=0,
        text=text,
        role="body",
        runs=[Run(index=0, text=text, format=_format())],
    )
    model = DocumentModel(paragraphs=[paragraph])

    assert fix_bold_range(model) == 1

    assert [run.text for run in paragraph.runs] == ["重点：", "后续正文" * 8]
    assert paragraph.runs[0].format.bold is True
    trailing = paragraph.runs[1].format
    assert trailing.bold is False
    assert trailing.latin_font_name == "Arial"
    assert trailing.italic is True
    assert trailing.underline is True
    assert trailing.color == "123456"


def test_heading_prefix_normalization_preserves_later_run_boundaries_and_formats():
    paragraph = Paragraph(
        index=0,
        text="1、标题正文",
        is_heading=True,
        heading_level=1,
        runs=[
            Run(index=0, text="1、", format=_format(font_name="黑体", color="111111")),
            Run(index=1, text="标题", format=_format(font_name="楷体", color="222222")),
            Run(index=2, text="正文", format=_format(font_name="仿宋", color="333333")),
        ],
    )
    model = DocumentModel(paragraphs=[paragraph])

    assert normalize_heading_content(model) == 1

    assert paragraph.text == "一、标题正文"
    assert [run.text for run in paragraph.runs] == ["一、", "标题", "正文"]
    assert [run.format.font_name for run in paragraph.runs] == ["黑体", "楷体", "仿宋"]
    assert [run.format.color for run in paragraph.runs] == ["111111", "222222", "333333"]
