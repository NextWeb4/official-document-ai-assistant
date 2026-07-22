import asyncio

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main
from api.routes import ai as ai_routes
from api.routes import settings
from config import get_app_mode


def test_app_mode_defaults_to_offline(monkeypatch):
    monkeypatch.delenv("APP_MODE", raising=False)
    assert get_app_mode() == "offline"


def test_invalid_app_mode_falls_back_to_offline(monkeypatch):
    monkeypatch.setenv("APP_MODE", "unexpected")
    assert get_app_mode() == "offline"


def test_backend_has_no_lan_network_config_helpers():
    assert main.HOST == "127.0.0.1"
    assert not hasattr(main, "_bind_host_from_network_config")
    assert not hasattr(settings, "_NETWORK_CONFIG_FILE")
    assert not hasattr(settings, "_load_network_config")
    assert not hasattr(settings, "_save_network_config")
    assert not hasattr(settings, "_get_lan_ip")
    assert not hasattr(settings, "NetworkToggleRequest")


def test_settings_routes_do_not_expose_network_toggle(monkeypatch):
    monkeypatch.setenv("APP_MODE", "offline")
    client = TestClient(main.app)

    app_mode = client.get("/api/settings/app-mode")
    assert app_mode.status_code == 200
    assert app_mode.json() == {
        "app_mode": "offline",
        "network_access_available": False,
    }

    assert client.get("/api/settings/network").status_code == 404
    assert client.post("/api/settings/network", json={"enabled": True}).status_code == 404


def test_offline_ai_providers_expose_only_ollama(monkeypatch):
    monkeypatch.setenv("APP_MODE", "offline")
    client = TestClient(main.app)

    providers = client.get("/api/ai/providers")

    assert providers.status_code == 200
    payload = providers.json()
    assert payload["app_mode"] == "offline"
    assert [item["provider"] for item in payload["providers"]] == ["ollama"]
    assert payload["default"]["provider"] == "ollama"
    assert payload["default"]["base_url"] == "http://localhost:11434/v1"


def test_offline_default_ai_config_is_local_ollama(monkeypatch):
    monkeypatch.setenv("APP_MODE", "offline")
    client = TestClient(main.app)

    default = client.get("/api/ai/default")

    assert default.status_code == 200
    payload = default.json()
    assert payload["app_mode"] == "offline"
    assert payload["provider"] == "ollama"
    assert payload["base_url"] == "http://localhost:11434/v1"
    assert payload["model"]


def test_offline_ai_policy_allows_only_ollama_loopback(monkeypatch):
    monkeypatch.setenv("APP_MODE", "offline")

    ai_routes._assert_ai_endpoint_allowed("ollama", "")
    ai_routes._assert_ai_endpoint_allowed("ollama", "http://127.0.0.1:11434/v1")
    ai_routes._assert_ai_endpoint_allowed("ollama", "http://localhost:11434/v1")

    blocked = [
        ("openai", "http://127.0.0.1:11434/v1"),
        ("custom", "http://localhost:1234/v1"),
        ("ollama", "https://api.openai.com/v1"),
    ]
    for provider, base_url in blocked:
        with pytest.raises(HTTPException) as exc:
            ai_routes._assert_ai_endpoint_allowed(provider, base_url)
        assert exc.value.status_code == 403


def test_offline_ai_routes_forbid_remote_endpoint(monkeypatch):
    monkeypatch.setenv("APP_MODE", "offline")

    with pytest.raises(HTTPException) as models_exc:
        asyncio.run(ai_routes.get_models(ai_routes.FetchModelsRequest(
            provider="ollama",
            base_url="https://api.openai.com/v1",
            api_key="x",
        ), db=None))

    assert models_exc.value.status_code == 403

    with pytest.raises(HTTPException) as test_exc:
        asyncio.run(ai_routes.test_ai_connection(ai_routes.AITestRequest(
            provider="openai",
            base_url="http://127.0.0.1:11434/v1",
            api_key="x",
        ), db=None))

    assert test_exc.value.status_code == 403
