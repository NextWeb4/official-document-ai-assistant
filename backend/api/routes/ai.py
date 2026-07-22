# This file is part of the Official Document AI Assistant.
# (c) 2026 Jose AI (https://www.linhut.cn)
# Licensed under the MIT License. See the LICENSE file for details.
"""
AI API routes: AI-powered analysis and suggestions.
支持多模型管理、模型列表获取、连接测试。
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from db.database import get_db
from db.models import AIConfig
from ai.manager import (
    create_provider, available_provider_infos, fetch_models,
    get_default_config, mask_api_key,
)
from services import document_service as doc_svc
from api.schemas.api_models import ApplyAIRequest
from utils.logger import logger
from utils.crypto import encrypt_value, decrypt_value
from config import get_app_mode, is_local_base_url, is_offline_mode
from services.document_service import export_filename

router = APIRouter()


class AIConfigRequest(BaseModel):
    provider: str
    api_key: str = ""
    base_url: str = ""
    model: str = ""
    is_active: bool | None = None


class AITestRequest(BaseModel):
    provider: str
    api_key: str
    base_url: str = ""
    model: str = ""


class FetchModelsRequest(BaseModel):
    base_url: str
    api_key: str
    provider: str = "custom"


def _suggestion_value_to_text(value) -> str:
    """Convert AI structured values to text without dropping numeric replacements."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _normalized_match_text(value: str) -> str:
    import re
    import unicodedata

    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value)).strip()


def _find_normalized_span(text: str, needle: str) -> tuple[int, int] | None:
    import re
    import unicodedata

    norm_chars: list[str] = []
    index_map: list[int] = []
    last_space = False
    for idx, ch in enumerate(text):
        normalized = unicodedata.normalize("NFKC", ch)
        for item in normalized:
            if item.isspace():
                if not last_space:
                    norm_chars.append(" ")
                    index_map.append(idx)
                    last_space = True
            else:
                norm_chars.append(item)
                index_map.append(idx)
                last_space = False

    norm_text = "".join(norm_chars)
    norm_needle = _normalized_match_text(needle)
    if not norm_text or not norm_needle:
        return None

    match = re.search(re.escape(norm_needle), norm_text)
    if not match:
        return None

    start = index_map[match.start()]
    end = index_map[match.end() - 1] + 1
    return start, end


def _paragraph_text(para) -> str:
    if getattr(para, "runs", None):
        return "".join(run.text or "" for run in para.runs)
    return para.text or ""


def _collapse_paragraph_to_text(para, text: str) -> None:
    para.text = text
    if para.runs:
        para.runs[0].text = text
        for run in para.runs[1:]:
            run.text = ""


def _replace_once_in_paragraph(para, original: str, suggestion: str) -> bool:
    if not original:
        return False

    for run in para.runs:
        if original in (run.text or ""):
            run.text = (run.text or "").replace(original, suggestion, 1)
            para.text = _paragraph_text(para)
            return True

    full_text = _paragraph_text(para)
    if original in full_text:
        _collapse_paragraph_to_text(para, full_text.replace(original, suggestion, 1))
        return True

    span = _find_normalized_span(full_text, original)
    if span:
        start, end = span
        _collapse_paragraph_to_text(para, f"{full_text[:start]}{suggestion}{full_text[end:]}")
        return True

    return False


def _apply_suggestions_to_model(doc_model, suggestions) -> dict:
    """Apply suggestions and return explicit applied/failed details."""
    applied: list[dict] = []
    failed: list[dict] = []

    for idx, sug in enumerate(suggestions, start=1):
        original = _suggestion_value_to_text(getattr(sug, "original", None))
        suggestion = _suggestion_value_to_text(getattr(sug, "suggestion", None))
        location = getattr(sug, "location", None)

        if not original or not suggestion or original == suggestion:
            failed.append({
                "index": idx,
                "original": original,
                "suggestion": suggestion,
                "location": location,
                "reason": "原文或建议为空，或二者相同",
            })
            continue

        matched_para = None
        for para in doc_model.paragraphs:
            if _replace_once_in_paragraph(para, original, suggestion):
                matched_para = para
                break

        if matched_para is None:
            failed.append({
                "index": idx,
                "original": original,
                "suggestion": suggestion,
                "location": location,
                "reason": "未在当前文档中匹配到原文片段",
            })
        else:
            applied.append({
                "index": idx,
                "original": original,
                "suggestion": suggestion,
                "location": location,
                "paragraph_index": matched_para.index,
            })

    return {"applied": applied, "failed": failed}


def _offline_default_config() -> dict:
    return {
        "provider": "ollama",
        "api_key": "",
        "base_url": "http://localhost:11434/v1",
        "model": "qwen2.5:7b",
    }


def _offline_allows_ai_endpoint(provider: str, base_url: str) -> bool:
    if provider != "ollama":
        return False
    if provider == "ollama" and not base_url:
        return True
    return is_local_base_url(base_url)


def _assert_ai_endpoint_allowed(provider: str, base_url: str) -> None:
    if not is_offline_mode():
        return
    if _offline_allows_ai_endpoint(provider, base_url):
        return
    raise HTTPException(status_code=403, detail="离线版仅允许连接本机 AI 服务")


@router.get("/providers")
async def list_ai_providers():
    """List available AI providers with their default configs."""
    if is_offline_mode():
        default = _offline_default_config()
        providers = [
            {
                "provider": "ollama",
                "name": "Ollama (本地)",
                "default_base_url": "http://localhost:11434/v1",
                "default_model": "qwen2.5:7b",
                "available": True,
            }
        ]
    else:
        default = get_default_config()
        providers = available_provider_infos()
    default["api_key"] = mask_api_key(default["api_key"])
    return {
        "providers": providers,
        "default": default,
        "app_mode": get_app_mode(),
    }


@router.get("/status")
async def get_ai_model_status():
    """获取所有已配置 AI 模型的可用性状态（每 60 秒自动检测）。"""
    if is_offline_mode():
        return {"statuses": [], "total": 0, "app_mode": "offline"}

    from services.model_health import get_all_statuses
    statuses = get_all_statuses()
    return {"statuses": statuses, "total": len(statuses)}


@router.post("/config")
async def save_ai_config(req: AIConfigRequest, db: Session = Depends(get_db)):
    """Save AI provider configuration. API key is encrypted before storage."""
    try:
        if req.base_url or req.is_active is not False:
            _assert_ai_endpoint_allowed(req.provider, req.base_url)

        config = db.query(AIConfig).filter(AIConfig.provider == req.provider).first()

        if config:
            # 更新已有配置 — 仅更新非空字段
            if req.api_key:
                config.api_key_encrypted = encrypt_value(req.api_key)
            if req.base_url:
                config.base_url = req.base_url
            if req.model:
                config.model = req.model
            if req.is_active is not None:
                config.is_active = req.is_active
        else:
            # 新建配置
            api_key_to_save = req.api_key or ("ollama" if req.provider == "ollama" else "")
            if not api_key_to_save:
                raise HTTPException(status_code=400, detail="新建配置时必须提供 API Key")
            config = AIConfig(
                provider=req.provider,
                api_key_encrypted=encrypt_value(api_key_to_save),
                base_url=req.base_url,
                model=req.model,
                is_active=req.is_active if req.is_active is not None else False,
            )
            db.add(config)

        db.commit()
        logger.info(f"AI config saved: {req.provider}")

        return {"success": True, "message": "配置保存成功"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Save AI config failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/config/{provider}")
async def get_ai_config(provider: str, db: Session = Depends(get_db)):
    """Get AI provider configuration (API key masked)."""
    if is_offline_mode() and provider != "ollama":
        return {"exists": False, "app_mode": "offline"}

    config = db.query(AIConfig).filter(AIConfig.provider == provider).first()

    if not config:
        # 返回默认配置
        default = _offline_default_config() if is_offline_mode() else get_default_config()
        if provider == default["provider"]:
            return {
                "exists": False,
                "default": {
                    **default,
                    "api_key_masked": mask_api_key(default["api_key"]),
                },
                "message": "使用内置默认配置",
            }
        return {"exists": False}

    # 脱敏返回
    return {
        "exists": True,
        "provider": config.provider,
        "base_url": config.base_url,
        "model": config.model,
        "is_active": config.is_active,
        "api_key_masked": mask_api_key(decrypt_value(config.api_key_encrypted) or ""),
    }


def _resolve_api_key(api_key: str, provider: str, db: Session) -> str:
    """解析 API Key：__saved__ 占位符从数据库读取已保存的密钥。"""
    if api_key == "__saved__":
        config = db.query(AIConfig).filter(AIConfig.provider == provider).first()
        if config and config.api_key_encrypted:
            try:
                resolved = decrypt_value(config.api_key_encrypted)
                if resolved:
                    return resolved
            except Exception as e:
                logger.error(f"Failed to decrypt saved key: {e}")
        raise HTTPException(
            status_code=400,
            detail=f"未找到 {provider} 已保存的 API Key，请先保存该服务商配置",
        )
    return api_key


@router.post("/test")
async def test_ai_connection(req: AITestRequest, db: Session = Depends(get_db)):
    """Test AI provider connection with detailed error classification."""
    try:
        _assert_ai_endpoint_allowed(req.provider, req.base_url)
        resolved_key = _resolve_api_key(req.api_key, req.provider, db)
        provider = create_provider(req.provider, resolved_key, req.base_url, req.model)
        success = await provider.test_connection()

        if success:
            return {
                "success": True,
                "message": "连接成功",
                "provider": req.provider,
                "model": req.model or "default",
                "base_url": req.base_url,
            }
        else:
            return {
                "success": False,
                "message": "连接失败，请检查配置",
                "provider": req.provider,
            }
    except HTTPException:
        raise
    except ValueError as e:
        return {"success": False, "message": f"配置错误: {str(e)}", "error_type": "config"}
    except Exception as e:
        error_msg = str(e)
        # 分类错误信息
        if "401" in error_msg or "认证" in error_msg:
            error_type = "auth"
            user_msg = "API Key 无效或已过期"
        elif "403" in error_msg or "拒绝" in error_msg:
            error_type = "permission"
            user_msg = "访问被拒绝，请检查 API Key 权限"
        elif "404" in error_msg:
            error_type = "endpoint"
            user_msg = "API 端点不存在，请检查 Base URL"
        elif "超时" in error_msg or "timeout" in error_msg.lower():
            error_type = "timeout"
            user_msg = "连接超时，请检查网络或 Base URL"
        elif "连接" in error_msg or "connect" in error_msg.lower():
            error_type = "network"
            user_msg = "无法连接到服务器，请检查 Base URL 和网络"
        else:
            error_type = "unknown"
            user_msg = f"连接失败: {error_msg[:100]}"

        logger.error(f"AI connection test failed ({error_type}): {e}")
        return {
            "success": False,
            "message": user_msg,
            "error_type": error_type,
            "provider": req.provider,
        }


@router.post("/models")
async def get_models(req: FetchModelsRequest, db: Session = Depends(get_db)):
    """Fetch available models from an API endpoint."""
    try:
        _assert_ai_endpoint_allowed(req.provider, req.base_url)
        resolved_key = _resolve_api_key(req.api_key, req.provider, db)
        models = await fetch_models(req.base_url, resolved_key)
        return {
            "success": True,
            "models": models,
            "count": len(models),
        }
    except HTTPException:
        raise
    except Exception as e:
        return {
            "success": False,
            "message": str(e),
            "models": [],
        }


@router.get("/default")
async def get_default_ai_config():
    """Get default AI configuration (API key masked)."""
    default = _offline_default_config() if is_offline_mode() else get_default_config()
    default["api_key"] = mask_api_key(default["api_key"])
    default["app_mode"] = get_app_mode()
    return default


@router.post("/analyze/{doc_id}")
async def ai_analyze(doc_id: int, provider: str, document_type: str = "", db: Session = Depends(get_db)):
    """Run AI analysis on a document."""
    doc = doc_svc.get_document(db, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")

    # 确定文档类型：参数 > 数据库记录 > 默认 notice
    doc_type = document_type or doc.document_type or "notice"

    # 分析只能使用调用方明确选择且已启用的配置。
    config = db.query(AIConfig).filter(AIConfig.provider == provider).first()
    if not config:
        raise HTTPException(status_code=400, detail=f"未找到 {provider} 的 AI 配置")
    if not config.is_active:
        raise HTTPException(status_code=400, detail=f"{provider} 的 AI 配置未启用")

    provider_name = config.provider
    base_url = config.base_url or ""
    model = config.model or ""
    _assert_ai_endpoint_allowed(provider_name, base_url)

    try:
        api_key = decrypt_value(config.api_key_encrypted) if config.api_key_encrypted else ""
    except Exception as e:
        logger.error(f"Failed to decrypt AI key for {provider_name}: {e}")
        raise HTTPException(status_code=400, detail=f"无法读取 {provider_name} 的 API Key，请重新保存配置")
    if not api_key:
        if provider_name == "ollama":
            api_key = "ollama"
        else:
            raise HTTPException(status_code=400, detail=f"{provider_name} 的 API Key 未配置")

    try:
        # 解析文档内容
        from core.document.parser import parse_docx
        source_path = doc_svc.get_current_document_source(doc)
        doc_model = parse_docx(str(source_path))
        doc_text = "\n".join([p.text for p in doc_model.paragraphs if p.text.strip()])

        # 调用 AI
        ai_provider = create_provider(provider_name, api_key, base_url, model)
        import inspect
        analyze = ai_provider.analyze
        if "document_type" in inspect.signature(analyze).parameters:
            result = await analyze(doc_text, document_type=doc_type)
        else:
            result = await analyze(doc_text)

        return {
            "success": True,
            "provider": provider_name,
            "issues": result.issues,
            "raw_response": result.raw_response,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"AI analyze failed: {e}")
        return {
            "success": False,
            "message": f"AI 分析失败: {str(e)[:100]}",
        }


@router.post("/apply/{doc_id}")
async def apply_ai_suggestions(doc_id: int, req: ApplyAIRequest, db: Session = Depends(get_db)):
    """将用户选中的 AI 建议应用到文档，生成优化后的 .docx。"""
    from core.document.parser import parse_docx
    from core.document.generator import generate_docx
    from config import OUTPUT_DIR
    from pathlib import Path

    doc = doc_svc.get_document(db, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="文档未找到")

    if not req.suggestions:
        raise HTTPException(status_code=400, detail="未选择任何建议")

    # 解析文档
    try:
        source_path = doc_svc.get_current_document_source(doc)
        doc_model = parse_docx(str(source_path))
    except Exception as e:
        logger.error(f"parse_docx failed for doc {doc_id}: {e}")
        raise HTTPException(status_code=500, detail=f"文档解析失败: {str(e)[:100]}")

    # 逐条应用建议：在段落文本中做原文替换，并记录未匹配项
    apply_result = _apply_suggestions_to_model(doc_model, req.suggestions)
    applied_details = apply_result["applied"]
    failed_details = apply_result["failed"]
    applied = len(applied_details)

    if applied == 0:
        return {
            "success": False,
            "applied_count": 0,
            "failed_count": len(failed_details),
            "failed_suggestions": failed_details,
            "message": "未能匹配到任何原文片段，建议可能已不适用于当前文档",
        }

    # 生成优化文档
    out_name = export_filename(doc.filename, "ai_optimized")
    out_path = OUTPUT_DIR / out_name
    try:
        generate_docx(doc_model, str(out_path))
    except Exception as e:
        doc_svc.remove_unreferenced_output(db, out_path)
        logger.error(f"generate_docx failed: {e}")
        raise HTTPException(status_code=500, detail=f"文档生成失败: {str(e)[:100]}")

    # 生成后复核：确认每个已应用建议的建议文本真实写入了生成文档。
    verification_failed: list[dict] = []
    try:
        generated_model = parse_docx(str(out_path))
        generated_text = "\n".join(p.text or "" for p in generated_model.paragraphs)
        for item in applied_details:
            if item["suggestion"] not in generated_text:
                verification_failed.append({
                    **item,
                    "reason": "生成文档复核未找到建议文本",
                })
    except Exception as e:
        logger.error(f"AI apply verification failed: {e}")
        doc_svc.remove_unreferenced_output(db, out_path)
        raise HTTPException(status_code=500, detail=f"生成文档复核失败: {str(e)[:100]}")

    # 更新 DB
    try:
        doc_svc.commit_optimized_output(db, doc, out_path)
    except Exception as e:
        logger.error(f"Failed to update doc {doc_id}: {e}")
        raise HTTPException(status_code=500, detail="数据库更新失败")

    all_failed = failed_details + verification_failed
    logger.info(
        f"AI suggestions applied: doc={doc_id}, applied={applied}/{len(req.suggestions)}, "
        f"failed={len(all_failed)}"
    )
    if all_failed:
        message = f"已应用 {applied} 项建议，{len(all_failed)} 项未完成，请查看失败提示"
    else:
        message = f"已成功应用 {applied} 项 AI 建议"
    return {
        "success": True,
        "applied_count": applied,
        "total_suggestions": len(req.suggestions),
        "failed_count": len(all_failed),
        "failed_suggestions": all_failed,
        "applied_suggestions": applied_details,
        "output_path": str(out_path),
        "message": message,
    }
