# This file is part of the Official Document AI Assistant.
# (c) 2026 Jose AI (https://www.linhut.cn)
# Licensed under the MIT License. See the LICENSE file for details.
"""
AI manager: loads provider config from DB, instantiates providers,
and delegates calls to the active provider.

本地版默认使用 Ollama，本文件保留 Provider 注册表用于兼容已有数据和测试。
"""
from __future__ import annotations
from typing import Any
import httpx

from ai.base import AIProvider, AIAnalysisResult
from ai.providers.openai_provider import OpenAIProvider
from ai.providers.deepseek_provider import DeepSeekProvider
from ai.providers.claude_provider import ClaudeProvider
from ai.providers.ollama_provider import OllamaProvider
from ai.providers.custom_provider import CustomProvider
from utils.logger import logger

# Registry: provider name -> class
_PROVIDER_REGISTRY: dict[str, type[AIProvider]] = {
    "openai": OpenAIProvider,
    "deepseek": DeepSeekProvider,
    "claude": ClaudeProvider,
    "ollama": OllamaProvider,
    "custom": CustomProvider,
}

# 默认在线配置。离线模式由 API 层覆盖为本机 Ollama。
import os
DEFAULT_PROVIDER_CONFIG = {
    "provider": os.environ.get("DEFAULT_AI_PROVIDER", "openai"),
    "base_url": os.environ.get("DEFAULT_AI_BASE_URL", "https://api.openai.com/v1"),
    "api_key": os.environ.get("DEFAULT_AI_API_KEY", ""),
    "model": os.environ.get("DEFAULT_AI_MODEL", "gpt-4o-mini"),
}


def register_provider(name: str, cls: type[AIProvider]):
    """Register a new provider class."""
    _PROVIDER_REGISTRY[name] = cls


def create_provider(
    provider_name: str,
    api_key: str,
    base_url: str = "",
    model: str = "",
    **kwargs,
) -> AIProvider:
    """Instantiate a provider by name."""
    cls = _PROVIDER_REGISTRY.get(provider_name)
    if cls is None:
        raise ValueError(f"Unknown AI provider: {provider_name}. Available: {list(_PROVIDER_REGISTRY)}")
    return cls(api_key=api_key, base_url=base_url, model=model, **kwargs)


def available_providers() -> list[str]:
    """Return the registered provider names."""
    return list(_PROVIDER_REGISTRY)


def available_provider_infos() -> list[dict[str, Any]]:
    """Return available providers with UI-facing default configuration."""
    providers = []
    for name, cls in _PROVIDER_REGISTRY.items():
        info = {
            "provider": name,
            "name": name,
            "class": cls.__name__,
            "description": cls.__doc__.strip().split("\n")[0] if cls.__doc__ else "",
        }
        if name == "openai":
            info["default_base_url"] = "https://api.openai.com/v1"
            info["default_model"] = "gpt-4o-mini"
        elif name == "deepseek":
            info["default_base_url"] = "https://api.deepseek.com/v1"
            info["default_model"] = "deepseek-chat"
        elif name == "claude":
            info["default_base_url"] = "https://api.anthropic.com"
            info["default_model"] = "claude-sonnet-4-20250514"
        elif name == "ollama":
            info["default_base_url"] = "http://localhost:11434/v1"
            info["default_model"] = "qwen2.5:7b"
        elif name == "custom":
            info["default_base_url"] = ""
            info["default_model"] = ""
        providers.append(info)
    return providers


async def fetch_models(base_url: str, api_key: str) -> list[str]:
    """
    从 API 端点获取可用模型列表。
    调用 /models 端点（OpenAI 兼容）。
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{base_url.rstrip('/')}/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            response.raise_for_status()
            data = response.json()
            models = [m["id"] for m in data.get("data", [])]
            logger.info(f"Fetched {len(models)} models from {base_url}")
            return models
    except httpx.HTTPStatusError as e:
        logger.error(f"Fetch models HTTP error: {e.response.status_code}")
        raise Exception(f"获取模型列表失败: HTTP {e.response.status_code}")
    except httpx.ConnectError:
        raise Exception(f"无法连接到 {base_url}")
    except httpx.TimeoutException:
        raise Exception(f"连接超时: {base_url}")
    except Exception as e:
        raise Exception(f"获取模型列表失败: {str(e)}")


def get_default_config() -> dict:
    """获取默认内置 AI 配置。"""
    return DEFAULT_PROVIDER_CONFIG.copy()


def mask_api_key(api_key: str) -> str:
    """脱敏显示 API Key。sk-xxxx****xxxx"""
    if not api_key or len(api_key) < 12:
        return "****"
    return f"{api_key[:7]}****{api_key[-4:]}"
