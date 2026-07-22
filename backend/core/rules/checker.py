# This file is part of the Official Document AI Assistant.
# (c) 2026 Jose AI (https://www.linhut.cn)
# Licensed under the MIT License. See the LICENSE file for details.
"""
Format checker: validates a DocumentModel against loaded rules.
Returns a list of CheckIssue objects.
"""
from __future__ import annotations
import re
from dataclasses import dataclass
from typing import Any

from core.document.models import DocumentModel, Paragraph
from utils.logger import logger


@dataclass
class CheckIssue:
    """A single issue found during format checking."""
    rule_id: str
    check_type: str        # format / typo / expression / logic
    severity: str          # P0 / P1 / P2
    name: str
    location: str          # e.g. "paragraph:3"
    original_text: str = ""
    suggested_fix: str = ""
    reason: str = ""


# Every field shipped in rules/official is deliberately classified. Fields in
# the unsupported set describe semantics that DocumentModel cannot represent
# reliably; they produce an explicit rule issue instead of a false pass.
_EXECUTABLE_OFFICIAL_CHECK_FIELDS = frozenset({
    "attachment.first_line_indent",
    "body.align",
    "body.bold_range",
    "body.first_line_indent",
    "body.font",
    "body.line_spacing",
    "body.size",
    "cc.font",
    "content.basis",
    "content.legal_basis",
    "date.align",
    "header.doc_number",
    "heading_1.first_line_indent",
    "heading_1.font",
    "heading_1.size",
    "heading_2.font",
    "heading_2.size",
    "heading_3.font",
    "heading_3.size",
    "page_number.font",
    "page_number.size",
    "page_setup.margins.bottom",
    "page_setup.margins.left",
    "page_setup.margins.right",
    "page_setup.margins.top",
    "page_setup.paper_width_mm",
    "recipient.font",
    "signature.align",
    "title.align",
    "title.bold",
    "title.font",
    "title.size",
})

_EXPLICITLY_UNSUPPORTED_OFFICIAL_CHECK_FIELDS = frozenset({
    "content.alternatives",
    "content.background",
    "content.clauses",
    "content.data",
    "content.decision_items",
    "content.decisions",
    "content.effective_date",
    "content.facts",
    "content.implementation_plan",
    "content.items",
    "content.measures",
    "content.meeting_elements",
    "content.meeting_info",
    "content.objectives",
    "content.procedure",
    "content.proposer",
    "content.purpose",
    "content.reason",
    "content.reply_to",
    "content.report_items",
    "content.resolution_items",
    "content.scope",
    "content.single_topic",
    "content.structure",
    "content.suggestions",
    "content.timeline",
    "content.validity",
    "ending.check",
    "header.recipient",
    "language.formal",
    "page_number.alignment",
    "salutation.check",
    "signature.signer",
})

_HEADING_CHECK_FIELDS = frozenset(
    f"heading_{level}.{sub_field}"
    for level in range(4)
    for sub_field in ("font", "size", "align", "first_line_indent", "line_spacing", "bold")
)
_LEGACY_CHECK_FIELDS = _HEADING_CHECK_FIELDS | frozenset({
    "doc_title.align",
    "doc_title.bold",
    "doc_title.font",
    "doc_title.size",
    "page_setup.paper_height_mm",
})
_EXECUTABLE_CHECK_FIELDS = _EXECUTABLE_OFFICIAL_CHECK_FIELDS | _LEGACY_CHECK_FIELDS
SUPPORTED_CHECK_FIELDS = _EXECUTABLE_CHECK_FIELDS

_ROLE_FORMAT_FIELDS = {
    "attachment.first_line_indent": ("attachment", "first_line_indent"),
    "cc.font": ("cc", "font"),
    "recipient.font": ("recipient", "font"),
}

_LEGAL_BASIS_RE = re.compile(
    r"(?:根据|依据|依照|按照|遵照)\s*(?:《[^》]+》|[^。；\n]{0,30}(?:法|条例|规定|办法|决定|通知|意见|精神|要求))"
    r"|(?:鉴于|经[^。；\n]{0,20}(?:研究|审议))"
)
_DOC_NUMBER_RE = re.compile(
    r"(?:第\s*[一二三四五六七八九十百千万零〇0-9]+\s*号|"
    r"[\u4e00-\u9fff]{0,12}〔\d{4}〕\d+号)"
)


def check_document(model: DocumentModel, rules: dict[str, Any]) -> list[CheckIssue]:
    """
    Run all check_rules from the rule set against the document model.

    Args:
        model: Parsed document model.
        rules: Merged rule dictionary (common + type-specific).

    Returns:
        List of CheckIssue instances.
    """
    issues: list[CheckIssue] = []
    check_rules = rules.get("check_rules", [])

    for rule in check_rules:
        rule_id = rule.get("id", "UNKNOWN")
        field_path = rule.get("field", "")
        expected = rule.get("expected")
        severity = rule.get("severity", "P2")
        name = rule.get("name", "")
        message = rule.get("message", "")

        if field_path in _EXPLICITLY_UNSUPPORTED_OFFICIAL_CHECK_FIELDS:
            issues.append(_unsupported_field_issue(
                rule_id, severity, name, field_path, expected,
                _unsupported_field_reason(field_path),
            ))
            continue
        if field_path not in _EXECUTABLE_CHECK_FIELDS:
            issues.append(_unsupported_field_issue(
                rule_id, severity, name, field_path, expected,
                "没有注册对应的 DocumentModel 检查处理器",
            ))
            continue

        # Dispatch based on field path prefix
        if field_path.startswith("heading_0."):
            issues.extend(_check_heading_level(model, rule_id, severity, name, field_path, expected, message, level=0))
        elif field_path.startswith("doc_title."):
            issues.extend(_check_title(model, rule_id, severity, name, field_path, expected, message))
        elif field_path.startswith("heading_1."):
            issues.extend(_check_heading_level(model, rule_id, severity, name, field_path, expected, message, level=1))
        elif field_path.startswith("heading_2."):
            issues.extend(_check_heading_level(model, rule_id, severity, name, field_path, expected, message, level=2))
        elif field_path.startswith("heading_3."):
            issues.extend(_check_heading_level(model, rule_id, severity, name, field_path, expected, message, level=3))
        elif field_path.startswith("title."):
            issues.extend(_check_title(model, rule_id, severity, name, field_path, expected, message))
        elif field_path.startswith("body."):
            issues.extend(_check_body(model, rule_id, severity, name, field_path, expected, message))
        elif field_path.startswith("page_setup."):
            issues.extend(_check_page_setup(model, rule_id, severity, name, field_path, expected, message))
        elif field_path in _ROLE_FORMAT_FIELDS:
            issues.extend(_check_role_format(model, rule_id, severity, name, field_path, expected, message))
        elif field_path.startswith("page_number."):
            issues.extend(_check_page_number(model, rule_id, severity, name, field_path, expected, message))
        elif field_path in {"signature.align", "date.align"}:
            issues.extend(_check_signature_area(model, rule_id, severity, name, field_path, expected, message, rules))
        elif field_path == "header.doc_number":
            issues.extend(_check_document_number(model, rule_id, severity, name, expected, message))
        elif field_path in {"content.basis", "content.legal_basis"}:
            issues.extend(_check_legal_basis(model, rule_id, severity, name, expected, message))

    # Additional heuristic checks (not from YAML)
    issues.extend(_check_common_issues(model))

    logger.info(f"Check complete: {len(issues)} issues found")
    return issues


# ---------------------------------------------------------------------------
#  Sub-checkers
# ---------------------------------------------------------------------------

def _unsupported_field_issue(
    rule_id: str,
    severity: str,
    name: str,
    field_path: str,
    expected: Any,
    detail: str,
) -> CheckIssue:
    """Reject a rule field explicitly while preserving the checker return API."""
    logger.error(f"Unsupported check field '{field_path}' in rule '{rule_id}': {detail}")
    return CheckIssue(
        rule_id=rule_id,
        check_type="logic",
        severity=severity,
        name=name or "不支持的规则字段",
        location="document",
        original_text=field_path or "(空字段)",
        suggested_fix=f"实现该字段处理器后再启用规则（期望值：{expected}）",
        reason=f"规则字段“{field_path or '(空字段)'}”未执行：{detail}",
    )


def _unsupported_field_reason(field_path: str) -> str:
    if field_path == "page_number.alignment":
        return "DocumentModel 未记录奇偶页页脚类型，无法验证外侧对齐"
    if field_path == "signature.signer":
        return "DocumentModel 未记录签发人身份，无法验证是否由行政首长签署"
    if field_path in {"salutation.check", "language.formal"}:
        return "该语义要求无法从当前 DocumentModel 结构可靠判定"
    if field_path == "ending.check":
        return "规则未提供可机器判定的结构化结语条件"
    return "该内容规则需要尚未提供的结构化语义分析结果"


def _find_title_paragraph(model: DocumentModel) -> Paragraph | None:
    for predicate in (
        lambda p: p.is_heading and p.heading_level == 0,
        lambda p: p.role == "title",
        lambda p: p.is_heading and p.heading_level == 1,
    ):
        title = next((p for p in model.paragraphs if p.text.strip() and predicate(p)), None)
        if title is not None:
            return title
    return None


def _expected_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized == "true":
            return True
        if normalized == "false":
            return False
    return None


def _check_title(model, rule_id, severity, name, field_path, expected, message) -> list[CheckIssue]:
    """Check document main title paragraph formatting (heading_level=0)."""
    issues = []
    title_para = _find_title_paragraph(model)
    if title_para is None:
        # Check if first non-empty paragraph could be the title
        non_empty = [p for p in model.paragraphs if p.text.strip()]
        if non_empty:
            issues.append(CheckIssue(
                rule_id=rule_id, check_type="format", severity=severity,
                name=name, location=f"paragraph:{non_empty[0].index}",
                original_text=non_empty[0].text[:80],
                suggested_fix="使用标题样式或设置方正小标宋简体字体",
                reason="未检测到公文标题（方正小标宋简体/居中22pt），请检查标题格式",
            ))
        return issues

    sub_field = field_path.split(".", 1)[1] if "." in field_path else ""

    if sub_field == "font":
        for run in title_para.runs:
            if run.format.font_name is None or run.format.font_name != expected:
                issues.append(CheckIssue(
                    rule_id=rule_id, check_type="format", severity=severity,
                    name=name, location=f"paragraph:{title_para.index}",
                    original_text=run.format.font_name, suggested_fix=str(expected),
                    reason=message,
                ))
                break
    elif sub_field == "size":
        expected_pt = _expected_length_pt(expected)
        if expected_pt is None:
            return [_unsupported_field_issue(
                rule_id, severity, name, field_path, expected,
                "字号期望值无法转换为 pt",
            )]
        runs = [run for run in title_para.runs if run.text.strip()] or title_para.runs
        actual_values = [run.format.font_size_pt for run in runs]
        if not actual_values or any(
            value is None or abs(value - expected_pt) > 0.5 for value in actual_values
        ):
            issues.append(CheckIssue(
                rule_id=rule_id, check_type="format", severity=severity,
                name=name, location=f"paragraph:{title_para.index}",
                original_text=", ".join("未设置" if value is None else f"{value}pt" for value in actual_values)
                or "未检测到文本运行",
                suggested_fix=str(expected), reason=message,
            ))
    elif sub_field == "align":
        actual = title_para.format.alignment
        if actual and actual != str(expected).lower():
            issues.append(CheckIssue(
                rule_id=rule_id, check_type="format", severity=severity,
                name=name, location=f"paragraph:{title_para.index}",
                original_text=actual, suggested_fix=str(expected),
                reason=message,
            ))

    elif sub_field == "bold":
        expected_bool = _expected_bool(expected)
        if expected_bool is None:
            return [_unsupported_field_issue(
                rule_id, severity, name, field_path, expected,
                "bold 的期望值必须是布尔值",
            )]
        runs = [run for run in title_para.runs if run.text.strip()] or title_para.runs
        actual_values = [bool(run.format.bold) for run in runs]
        if not actual_values or any(actual != expected_bool for actual in actual_values):
            issues.append(CheckIssue(
                rule_id=rule_id, check_type="format", severity=severity,
                name=name, location=f"paragraph:{title_para.index}",
                original_text=", ".join(map(str, actual_values)) or "未检测到文本运行",
                suggested_fix=str(expected_bool), reason=message,
            ))

    return issues


def _check_heading_level(model, rule_id, severity, name, field_path, expected, message, level: int) -> list[CheckIssue]:
    """
    检查指定级别的标题段落格式。

    Args:
        level: 标题级别 (0=公文大标题, 1=一级标题, 2=二级标题, 3=三级标题)
    """
    issues = []
    headings = [p for p in model.paragraphs if p.is_heading and p.heading_level == level]
    if level == 1 and not any(p.is_heading and p.heading_level == 0 for p in model.paragraphs):
        first_non_empty = next((p for p in model.paragraphs if p.text.strip()), None)
        headings = [p for p in headings if p is not first_non_empty]

    if not headings:
        # 对于 level 0 的大标题，尝试回退到第一个非空段落
        if level == 0:
            non_empty = [p for p in model.paragraphs if p.text.strip()]
            if non_empty:
                issues.append(CheckIssue(
                    rule_id=rule_id, check_type="format", severity=severity,
                    name=name, location=f"paragraph:{non_empty[0].index}",
                    original_text=non_empty[0].text[:80],
                    suggested_fix="使用标题样式或设置标题字体",
                    reason=f"未检测到{level}级标题",
                ))
        return issues

    sub_field = field_path.split(".", 1)[1] if "." in field_path else ""

    _NUMERIC_FIELDS = {"size", "line_spacing", "first_line_indent"}
    expected_val = _expected_length_pt(expected) if sub_field in _NUMERIC_FIELDS else None
    if sub_field in _NUMERIC_FIELDS and expected_val is None:
        return [_unsupported_field_issue(
            rule_id, severity, name, field_path, expected,
            "数值格式期望值无法转换为 pt",
        )]

    # 检查该级别的所有标题段落
    for title_para in headings:

        if sub_field == "font":
            for run in title_para.runs:
                if run.format.font_name is None or run.format.font_name != expected:
                    issues.append(CheckIssue(
                        rule_id=rule_id, check_type="format", severity=severity,
                        name=name, location=f"paragraph:{title_para.index}",
                        original_text=run.format.font_name, suggested_fix=str(expected),
                        reason=message,
                    ))
                    break
        elif sub_field == "size":
            runs = [run for run in title_para.runs if run.text.strip()] or title_para.runs
            actual_values = [run.format.font_size_pt for run in runs]
            if not actual_values or any(
                value is None or abs(value - expected_val) > 0.5 for value in actual_values
            ):
                issues.append(CheckIssue(
                    rule_id=rule_id, check_type="format", severity=severity,
                    name=name, location=f"paragraph:{title_para.index}",
                    original_text=", ".join("未设置" if value is None else f"{value}pt" for value in actual_values)
                    or "未检测到文本运行",
                    suggested_fix=str(expected), reason=message,
                ))
        elif sub_field == "align":
            actual = title_para.format.alignment
            if actual and actual != str(expected).lower():
                issues.append(CheckIssue(
                    rule_id=rule_id, check_type="format", severity=severity,
                    name=name, location=f"paragraph:{title_para.index}",
                    original_text=actual, suggested_fix=str(expected),
                    reason=message,
                ))
        elif sub_field == "first_line_indent":
            actual = title_para.format.first_line_indent_pt
            if actual is None or abs(actual - expected_val) > 4:
                issues.append(CheckIssue(
                    rule_id=rule_id, check_type="format", severity=severity,
                    name=name, location=f"paragraph:{title_para.index}",
                    original_text="未设置" if actual is None else f"{actual}pt",
                    suggested_fix=str(expected), reason=message,
                ))
        elif sub_field == "line_spacing":
            actual = title_para.format.line_spacing_pt
            if actual is None or abs(actual - expected_val) > 1:
                issues.append(CheckIssue(
                    rule_id=rule_id, check_type="format", severity=severity,
                    name=name, location=f"paragraph:{title_para.index}",
                    original_text="未设置" if actual is None else f"{actual}pt",
                    suggested_fix=str(expected), reason=message,
                ))
        elif sub_field == "bold":
            expected_bool = _expected_bool(expected)
            if expected_bool is None:
                return [_unsupported_field_issue(
                    rule_id, severity, name, field_path, expected,
                    "bold 的期望值必须是布尔值",
                )]
            runs = [run for run in title_para.runs if run.text.strip()] or title_para.runs
            actual_values = [bool(run.format.bold) for run in runs]
            if not actual_values or any(actual != expected_bool for actual in actual_values):
                issues.append(CheckIssue(
                    rule_id=rule_id, check_type="format", severity=severity,
                    name=name, location=f"paragraph:{title_para.index}",
                    original_text=", ".join(map(str, actual_values)) or "未检测到文本运行",
                    suggested_fix=str(expected_bool), reason=message,
                ))

    return issues


def _check_body(model, rule_id, severity, name, field_path, expected, message) -> list[CheckIssue]:
    """Check body paragraph formatting (excluding signature/date)."""
    issues = []
    _EXCLUDE_ROLES = {'signature', 'date'}
    body_paras = [p for p in model.paragraphs
                  if not p.is_heading and p.text.strip() and p.role not in _EXCLUDE_ROLES]
    if not body_paras:
        return issues

    sub_field = field_path.split(".", 1)[1] if "." in field_path else ""

    # Only attempt numeric conversion for fields that expect numeric values.
    # Font fields pass a string like "仿宋_GB2312" which would crash float().
    _NUMERIC_FIELDS = {"size", "line_spacing", "first_line_indent"}
    expected_val = _expected_length_pt(expected) if sub_field in _NUMERIC_FIELDS else None
    if sub_field in _NUMERIC_FIELDS and expected_val is None:
        return [_unsupported_field_issue(
            rule_id, severity, name, field_path, expected,
            "数值格式期望值无法转换为 pt",
        )]

    for para in body_paras:  # Check ALL body paragraphs
        if sub_field == "font":
            for run in para.runs:
                if run.format.font_name is None or run.format.font_name != expected:
                    issues.append(CheckIssue(
                        rule_id=rule_id, check_type="format", severity=severity,
                        name=name, location=f"paragraph:{para.index}",
                        original_text=run.format.font_name, suggested_fix=str(expected),
                        reason=message,
                    ))
                    break
        elif sub_field == "size":
            runs = [run for run in para.runs if run.text.strip()] or para.runs
            actual_values = [run.format.font_size_pt for run in runs]
            if not actual_values or any(
                value is None or abs(value - expected_val) > 0.5 for value in actual_values
            ):
                issues.append(CheckIssue(
                    rule_id=rule_id, check_type="format", severity=severity,
                    name=name, location=f"paragraph:{para.index}",
                    original_text=", ".join("未设置" if value is None else f"{value}pt" for value in actual_values)
                    or "未检测到文本运行",
                    suggested_fix=str(expected), reason=message,
                ))
        elif sub_field == "line_spacing":
            actual = para.format.line_spacing_pt
            if actual is None or abs(actual - expected_val) > 1:
                issues.append(CheckIssue(
                    rule_id=rule_id, check_type="format", severity=severity,
                    name=name, location=f"paragraph:{para.index}",
                    original_text="未设置" if actual is None else f"{actual}pt",
                    suggested_fix=str(expected), reason=message,
                ))
        elif sub_field == "first_line_indent":
            actual = para.format.first_line_indent_pt
            if actual is None or abs(actual - expected_val) > 4:
                issues.append(CheckIssue(
                    rule_id=rule_id, check_type="format", severity=severity,
                    name=name, location=f"paragraph:{para.index}",
                    original_text="无缩进" if actual is None else f"{actual}pt",
                    suggested_fix=str(expected),
                    reason=message or f"正文首行缩进不符合要求（期望{expected}）",
                ))
        elif sub_field == "align":
            actual = para.format.alignment
            if actual and actual != str(expected).lower():
                issues.append(CheckIssue(
                    rule_id=rule_id, check_type="format", severity=severity,
                    name=name, location=f"paragraph:{para.index}",
                    original_text=actual, suggested_fix=str(expected),
                    reason=message,
                ))
        elif sub_field == "bold_range":
            # 检查正文段落是否整段加粗（通常只有首句/点题词应加粗）
            if len(para.text.strip()) > 30 and para.runs:
                all_bold = all(r.format.bold for r in para.runs if r.text.strip())
                if all_bold:
                    issues.append(CheckIssue(
                        rule_id=rule_id, check_type="content", severity=severity,
                        name=name, location=f"paragraph:{para.index}",
                        original_text=para.text[:60],
                        suggested_fix="仅首句/点题词加粗",
                        reason=message or "整段加粗不符合公文规范，通常仅首句或点题词需要加粗",
                    ))

    return issues


def _check_page_setup(model, rule_id, severity, name, field_path, expected, message) -> list[CheckIssue]:
    """Check page setup values."""
    issues = []
    sub_field = field_path.split(".", 1)[1] if "." in field_path else ""
    ps = model.page_setup

    field_map = {
        "margins.top": ("margin_top_mm", expected),
        "margins.bottom": ("margin_bottom_mm", expected),
        "margins.left": ("margin_left_mm", expected),
        "margins.right": ("margin_right_mm", expected),
        "paper_width_mm": ("paper_width_mm", expected),
        "paper_height_mm": ("paper_height_mm", expected),
    }

    if sub_field in field_map:
        attr_name, exp = field_map[sub_field]
        actual = getattr(ps, attr_name, None)
        exp_str = str(exp).strip().lower() if exp is not None else ""
        try:
            if exp_str.endswith("cm"):
                exp_mm = float(exp_str[:-2].strip()) * 10
            elif exp_str.endswith("mm"):
                exp_mm = float(exp_str[:-2].strip())
            else:
                exp_mm = float(exp_str)
        except (ValueError, TypeError):
            return [_unsupported_field_issue(
                rule_id, severity, name, field_path, expected,
                "页面尺寸期望值无法转换为 mm",
            )]
        if actual is None or abs(actual - exp_mm) > 2:
            issues.append(CheckIssue(
                rule_id=rule_id, check_type="format", severity=severity,
                name=name, location="page_setup",
                original_text="未设置" if actual is None else f"{actual}mm",
                suggested_fix=str(expected), reason=message,
            ))

    return issues


def _check_role_format(model, rule_id, severity, name, field_path, expected, message) -> list[CheckIssue]:
    """Check fields whose target is represented by an explicit paragraph role."""
    role, sub_field = _ROLE_FORMAT_FIELDS[field_path]
    paragraphs = [p for p in model.paragraphs if p.role == role and p.text.strip()]
    issues: list[CheckIssue] = []

    for para in paragraphs:
        if sub_field == "font":
            runs = [run for run in para.runs if run.text.strip()]
            actual_fonts = [run.format.font_name for run in runs]
            if not actual_fonts or any(font != expected for font in actual_fonts):
                issues.append(CheckIssue(
                    rule_id=rule_id, check_type="format", severity=severity,
                    name=name, location=f"paragraph:{para.index}",
                    original_text=", ".join(font or "未设置" for font in actual_fonts) or "未检测到文本运行",
                    suggested_fix=str(expected), reason=message,
                ))
        elif sub_field == "first_line_indent":
            expected_pt = _expected_length_pt(expected)
            actual_pt = para.format.first_line_indent_pt
            if expected_pt is None:
                issues.append(_unsupported_field_issue(
                    rule_id, severity, name, field_path, expected,
                    "首行缩进期望值无法转换为 pt",
                ))
            elif actual_pt is None or abs(actual_pt - expected_pt) > 4:
                issues.append(CheckIssue(
                    rule_id=rule_id, check_type="format", severity=severity,
                    name=name, location=f"paragraph:{para.index}",
                    original_text="无缩进" if actual_pt is None else f"{actual_pt}pt",
                    suggested_fix=str(expected), reason=message,
                ))
    return issues


def _expected_length_pt(value: Any) -> float | None:
    try:
        text = str(value).strip().lower()
        if text.endswith("em"):
            return float(text[:-2].strip()) * 16
        if text.endswith("pt"):
            return float(text[:-2].strip())
        return float(text)
    except (TypeError, ValueError):
        return None


def _check_page_number(model, rule_id, severity, name, field_path, expected, message) -> list[CheckIssue]:
    """Check PAGE-bearing footer runs; alignment remains explicitly unsupported."""
    footers = [footer for footer in model.footers if footer.has_page_number]
    if not footers:
        return [CheckIssue(
            rule_id=rule_id, check_type="format", severity=severity,
            name=name, location="page_footer", original_text="未检测到页码域",
            suggested_fix=str(expected), reason=message or "文档未包含动态页码域",
        )]

    sub_field = field_path.split(".", 1)[1]
    runs = [
        run
        for footer in footers
        for paragraph in footer.paragraphs
        for run in paragraph.runs
        if run.text.strip()
    ]
    if sub_field == "font":
        values = [run.format.font_name for run in runs]
        mismatch = not values or any(value != expected for value in values)
    elif sub_field == "size":
        expected_pt = _expected_length_pt(expected)
        values = [run.format.font_size_pt for run in runs]
        mismatch = (
            expected_pt is None
            or not values
            or any(value is None or abs(value - expected_pt) > 0.5 for value in values)
        )
    else:
        return [_unsupported_field_issue(
            rule_id, severity, name, field_path, expected,
            _unsupported_field_reason(field_path),
        )]

    if not mismatch:
        return []
    return [CheckIssue(
        rule_id=rule_id, check_type="format", severity=severity,
        name=name, location="page_footer",
        original_text=", ".join("未设置" if value is None else str(value) for value in values)
        or "未检测到页码文本运行",
        suggested_fix=str(expected), reason=message,
    )]


def _check_document_number(model, rule_id, severity, name, expected, message) -> list[CheckIssue]:
    """Check for a structured official-document number near the document start."""
    candidates = []
    for header in model.headers:
        candidates.append(header.text)
        candidates.extend(paragraph.text for paragraph in header.paragraphs)
    candidates.extend(paragraph.text for paragraph in model.paragraphs[:8])
    if any(_DOC_NUMBER_RE.search(text or "") for text in candidates):
        return []
    return [CheckIssue(
        rule_id=rule_id, check_type="content", severity=severity,
        name=name, location="document_header", original_text="未检测到发文字号",
        suggested_fix=str(expected), reason=message or "未检测到规范发文字号",
    )]


def _check_legal_basis(model, rule_id, severity, name, expected, message) -> list[CheckIssue]:
    """Check whether document text contains an explicit legal or policy basis."""
    text = "\n".join(paragraph.text for paragraph in model.paragraphs if paragraph.text.strip())
    if _LEGAL_BASIS_RE.search(text):
        return []
    return [CheckIssue(
        rule_id=rule_id, check_type="content", severity=severity,
        name=name, location="document_body", original_text="未检测到依据性表述",
        suggested_fix=str(expected), reason=message or "未检测到明确的法律、政策或研究依据",
    )]


def _check_signature_area(model, rule_id, severity, name, field_path, expected, message, rules) -> list[CheckIssue]:
    """Check signature/date area formatting. Only check last 2 non-empty paragraphs (落款+日期)."""
    issues = []
    paras = [p for p in model.paragraphs if not p.is_heading and p.text.strip()]
    if not paras:
        return issues

    # Signature area: only last 2 paragraphs (落款单位 + 日期)
    sig_paras = paras[-2:] if len(paras) >= 2 else paras
    sub_field = field_path.split(".", 1)[1] if "." in field_path else ""

    for para in sig_paras:
        if sub_field == "align":
            if para.format.alignment and para.format.alignment != str(expected).lower():
                issues.append(CheckIssue(
                    rule_id=rule_id, check_type="format", severity=severity,
                    name=name, location=f"paragraph:{para.index}",
                    original_text=para.format.alignment, suggested_fix=str(expected),
                    reason=message,
                ))

    return issues


def _check_common_issues(model: DocumentModel) -> list[CheckIssue]:
    """Heuristic checks not driven by YAML rules."""
    issues = []

    for para in model.paragraphs:
        text = para.text

        # Extra spaces (2+ consecutive spaces)
        if "  " in text:
            issues.append(CheckIssue(
                rule_id="CHK-HEUR-001", check_type="format", severity="P1",
                name="多余空格",
                location=f"paragraph:{para.index}",
                original_text=text[:80],
                suggested_fix="移除多余空格",
                reason="段落中存在连续空格",
            ))

        # Extra blank lines (empty paragraphs)
        if not text.strip() and para.index > 0:
            prev = model.paragraphs[para.index - 1] if para.index - 1 < len(model.paragraphs) else None
            if prev and not prev.text.strip():
                issues.append(CheckIssue(
                    rule_id="CHK-HEUR-002", check_type="format", severity="P2",
                    name="多余空行",
                    location=f"paragraph:{para.index}",
                    original_text="(空行)",
                    suggested_fix="移除多余空行",
                    reason="连续出现多个空行",
                ))

    # --- 页码检查（GB/T 9704: 公文应标注页码）---
    has_page_num = False
    for footer in model.footers:
        if footer.has_page_number:
            has_page_num = True
            break
    if not has_page_num and model.footers:
        # 有页脚但没有检测到页码域
        issues.append(CheckIssue(
            rule_id="CHK-HEUR-004", check_type="format", severity="P1",
            name="页码检查",
            location="page_footer",
            original_text="未检测到页码",
            suggested_fix="在页脚中插入页码（半角阿拉伯数字）",
            reason="GB/T 9704要求公文标注页码，版心下边缘居中",
        ))

    return issues
