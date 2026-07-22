# This file is part of the Official Document AI Assistant.
# (c) 2026 Jose AI (https://www.linhut.cn)
# Licensed under the MIT License. See the LICENSE file for details.
"""
Settings API routes: rule types and general configuration.
"""
from fastapi import APIRouter

from api.schemas.api_models import RuleTypeResponse
from core.rules.engine import RuleEngine
from config import get_app_mode
from utils.logger import logger

router = APIRouter()

@router.get("/rule-types", response_model=RuleTypeResponse)
async def get_rule_types():
    """List available document types with rule files."""
    types = RuleEngine.available_types()
    return RuleTypeResponse(types=types)


@router.get("/health")
async def settings_health():
    return {"status": "ok"}


@router.get("/app-mode")
async def get_app_mode_status():
    mode = get_app_mode()
    return {
        "app_mode": mode,
        "network_access_available": False,
    }
