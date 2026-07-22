import zipfile
import re
from pathlib import Path
from xml.etree import ElementTree as ET
from urllib.parse import unquote

from docx import Document
from fastapi.testclient import TestClient

from core.document.parser import parse_docx
from main import app


WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": WORD_NS}


def _read_docx_xml(docx_path: Path, part: str = "word/document.xml") -> str:
    with zipfile.ZipFile(docx_path, "r") as zf:
        return zf.read(part).decode("utf-8")


def _rfonts(xml: str) -> list[dict[str, str]]:
    root = ET.fromstring(xml)
    fonts: list[dict[str, str]] = []
    for elem in root.findall(".//w:rFonts", NS):
        values = {
            attr: elem.get(f"{{{WORD_NS}}}{attr}")
            for attr in ("ascii", "hAnsi", "eastAsia", "cs")
        }
        fonts.append({k: v for k, v in values.items() if v})
    return fonts


def test_preview_download_applies_live_format_config_to_docx(tmp_path):
    client = TestClient(app)
    payload = {
        "paragraphs": [
            {
                "text": "测试标题",
                "role": "title",
                "is_heading": True,
                "heading_level": 0,
                "format": {
                    "font_name": "Arial",
                    "font_size_pt": 10,
                    "alignment": "left",
                    "line_spacing_pt": 12,
                },
            },
            {
                "text": "测试正文123内容。",
                "role": "body",
                "is_heading": False,
                "format": {
                    "font_name": "Arial",
                    "font_size_pt": 10,
                    "alignment": "left",
                    "first_line_indent_pt": 0,
                    "line_spacing_pt": 12,
                },
            },
        ],
        "page_setup": {
            "margin_top_mm": 31,
            "margin_bottom_mm": 32,
            "margin_left_mm": 33,
            "margin_right_mm": 34,
        },
        "format_config": {
            "title": {
                "fontFamily": "方正小标宋简体",
                "fontSize": 26,
                "bold": False,
                "align": "center",
            },
            "body": {
                "fontFamily": "仿宋_GB2312",
                "asciiFontFamily": "宋体",
                "fontSize": 14,
                "lineSpacing": 30,
                "firstLineIndent": 1.5,
                "align": "justify",
            },
            "heading1": {"fontFamily": "黑体", "fontSize": 16, "bold": False, "indent": 0},
            "heading2": {"fontFamily": "楷体_GB2312", "fontSize": 16, "bold": False, "indent": 0},
            "heading3": {"fontFamily": "仿宋_GB2312", "fontSize": 16, "bold": True, "indent": 0},
            "header": {
                "enabled": True,
                "orgName": "测试机关文件",
                "docNumber": "测试发〔2026〕1号",
                "signer": "张三",
            },
            "footerNote": {
                "enabled": True,
                "cc": "测试单位",
                "printer": "测试办公室",
                "printDate": "2026年7月5日",
            },
            "pageNumber": {"show": True, "format": "dash"},
        },
        "source_filename": "数字字体测试.docx",
    }

    response = client.post("/api/optimize/preview-download", json=payload)
    assert response.status_code == 200
    disposition = response.headers["content-disposition"]
    decoded_disposition = unquote(disposition)
    assert re.search(r"数字字体测试_\d{8}_\d{4}\.docx", decoded_disposition)

    output = tmp_path / "preview_configured.docx"
    output.write_bytes(response.content)

    doc = Document(str(output))
    assert abs(doc.sections[0].top_margin.mm - 31) < 1
    assert abs(doc.sections[0].left_margin.mm - 33) < 1

    document_xml = _read_docx_xml(output)
    fonts = _rfonts(document_xml)
    east_asia_fonts = {f.get("eastAsia") for f in fonts}

    assert "Arial" not in document_xml
    assert "方正小标宋简体" in east_asia_fonts
    assert "仿宋_GB2312" in east_asia_fonts
    assert "测试机关文件" in document_xml
    assert "抄送：测试单位" in document_xml
    assert fonts
    assert all(f.get("ascii") == "宋体" for f in fonts)
    assert all(f.get("hAnsi") == "宋体" for f in fonts)

    root = ET.fromstring(document_xml)
    assert root.find('.//w:t[.="测试标题"]/../w:rPr/w:sz', NS).get(f"{{{WORD_NS}}}val") == "52"
    assert root.find('.//w:t[.="测试正文123内容。"]/../w:rPr/w:sz', NS).get(f"{{{WORD_NS}}}val") == "28"

    body_para = next(p for p in root.findall(".//w:p", NS) if p.find('.//w:t[.="测试正文123内容。"]', NS) is not None)
    body_rfonts = body_para.find('.//w:rFonts', NS)
    assert body_rfonts.get(f"{{{WORD_NS}}}ascii") == "宋体"
    assert body_rfonts.get(f"{{{WORD_NS}}}hAnsi") == "宋体"
    assert body_rfonts.get(f"{{{WORD_NS}}}eastAsia") == "仿宋_GB2312"
    spacing = body_para.find("./w:pPr/w:spacing", NS)
    indent = body_para.find("./w:pPr/w:ind", NS)
    assert body_para.find("./w:pPr/w:jc", NS).get(f"{{{WORD_NS}}}val") == "both"
    assert spacing.get(f"{{{WORD_NS}}}line") == "600"
    assert spacing.get(f"{{{WORD_NS}}}lineRule") == "exact"
    assert indent.get(f"{{{WORD_NS}}}firstLine") == "420"
    assert indent.get(f"{{{WORD_NS}}}firstLineChars") == "150"

    footer_xml = _read_docx_xml(output, "word/footer1.xml")
    footer_root = ET.fromstring(footer_xml)
    field_types = [
        node.get(f"{{{WORD_NS}}}fldCharType")
        for node in footer_root.findall(".//w:fldChar", NS)
    ]
    instructions = [
        (node.text or "").strip()
        for node in footer_root.findall(".//w:instrText", NS)
    ]
    text_nodes = [(node.text or "") for node in footer_root.findall(".//w:t", NS)]

    assert field_types == ["begin", "separate", "end"]
    assert instructions == ["PAGE"]
    assert "1" in text_nodes
    assert "— " in text_nodes
    assert " —" in text_nodes
    assert "— 1 —" not in text_nodes

    footer_jc = footer_root.find(".//w:p/w:pPr/w:jc", NS)
    assert footer_jc.get(f"{{{WORD_NS}}}val") == "right"

    footer_fonts = _rfonts(footer_xml)
    assert footer_fonts
    assert all(font.get("ascii") == "宋体" for font in footer_fonts)
    assert all(font.get("hAnsi") == "宋体" for font in footer_fonts)
    assert all(font.get("eastAsia") == "宋体" for font in footer_fonts)
    assert all(font.get("cs") == "宋体" for font in footer_fonts)

    roundtrip = parse_docx(output)
    assert any(footer.has_page_number for footer in roundtrip.footers)
