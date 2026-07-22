"""Regression tests for explicit default AI endpoint configuration."""

import main


def test_default_ai_config_requires_explicit_base_url(monkeypatch):
    monkeypatch.setenv("DEFAULT_AI_API_KEY", "test-key")
    monkeypatch.delenv("DEFAULT_AI_BASE_URL", raising=False)
    monkeypatch.delenv("DEFAULT_AI_MODEL", raising=False)

    assert main._read_default_ai_config_env() is None


def test_default_ai_config_reads_only_explicit_endpoint(monkeypatch):
    monkeypatch.setenv("DEFAULT_AI_API_KEY", "test-key")
    monkeypatch.setenv("DEFAULT_AI_BASE_URL", "https://api.example.test/v1")
    monkeypatch.setenv("DEFAULT_AI_MODEL", "example-model")

    assert main._read_default_ai_config_env() == (
        "test-key",
        "https://api.example.test/v1",
        "example-model",
    )
