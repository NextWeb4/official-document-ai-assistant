from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from ai.base import AIAnalysisResult
from api.routes import ai as ai_routes
from db.database import Base
from db.models import AIConfig, Document
from utils.crypto import encrypt_value


@pytest.fixture
def db_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    session = sessionmaker(bind=engine)()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(bind=engine)
        engine.dispose()


def _add_document(db_session) -> Document:
    document = Document(
        filename="test.docx",
        file_path="test.docx",
        file_hash="test-hash",
        document_type="notice",
    )
    db_session.add(document)
    db_session.commit()
    db_session.refresh(document)
    return document


def _add_config(
    db_session,
    provider: str,
    *,
    active: bool,
    api_key: str = "test-key",
    base_url: str = "https://example.test/v1",
    model: str = "test-model",
) -> AIConfig:
    config = AIConfig(
        provider=provider,
        api_key_encrypted=encrypt_value(api_key) if api_key else "",
        base_url=base_url,
        model=model,
        is_active=active,
    )
    db_session.add(config)
    db_session.commit()
    return config


async def test_analyze_uses_exact_requested_active_provider(monkeypatch, db_session):
    monkeypatch.setenv("APP_MODE", "online")
    document = _add_document(db_session)
    _add_config(
        db_session,
        "openai",
        active=True,
        api_key="unrelated-key",
        base_url="https://api.openai.test/v1",
        model="unrelated-model",
    )
    _add_config(
        db_session,
        "deepseek",
        active=True,
        api_key="deepseek-key",
        base_url="https://api.deepseek.test/v1",
        model="deepseek-model",
    )

    from core.document import parser as parser_module

    monkeypatch.setattr(
        parser_module,
        "parse_docx",
        lambda _path: SimpleNamespace(paragraphs=[SimpleNamespace(text="待分析正文")]),
    )
    monkeypatch.setattr(
        ai_routes.doc_svc,
        "get_current_document_source",
        lambda doc: doc.file_path,
    )
    created = []

    class FakeProvider:
        async def analyze(self, document_text: str):
            assert document_text == "待分析正文"
            return AIAnalysisResult(issues=[], raw_response="ok")

    def fake_create_provider(provider, api_key, base_url, model):
        created.append((provider, api_key, base_url, model))
        return FakeProvider()

    monkeypatch.setattr(ai_routes, "create_provider", fake_create_provider)
    result = await ai_routes.ai_analyze(
        document.id,
        provider="deepseek",
        document_type="report",
        db=db_session,
    )

    assert result["success"] is True
    assert result["provider"] == "deepseek"
    assert created == [(
        "deepseek",
        "deepseek-key",
        "https://api.deepseek.test/v1",
        "deepseek-model",
    )]


@pytest.mark.parametrize("requested_state", ["missing", "inactive"])
async def test_analyze_rejects_missing_or_inactive_requested_config(
    monkeypatch,
    db_session,
    requested_state,
):
    monkeypatch.setenv("APP_MODE", "online")
    document = _add_document(db_session)
    _add_config(db_session, "openai", active=True, api_key="other-provider-key")
    if requested_state == "inactive":
        _add_config(db_session, "deepseek", active=False, api_key="inactive-key")

    def must_not_run(*_args, **_kwargs):
        raise AssertionError("analysis provider must not be created")

    monkeypatch.setattr(ai_routes, "create_provider", must_not_run)

    with pytest.raises(HTTPException) as exc:
        await ai_routes.ai_analyze(document.id, provider="deepseek", db=db_session)

    assert exc.value.status_code == 400
    expected = "未找到" if requested_state == "missing" else "未启用"
    assert expected in exc.value.detail


async def test_saved_key_is_scoped_to_requested_provider(monkeypatch, db_session):
    monkeypatch.setenv("APP_MODE", "online")
    monkeypatch.setattr(ai_routes, "get_default_config", lambda: {"api_key": "unrelated-default-key"})
    _add_config(db_session, "openai", active=True, api_key="openai-only-key")

    def must_not_create_provider(*_args, **_kwargs):
        raise AssertionError("missing saved key must stop before provider creation")

    monkeypatch.setattr(ai_routes, "create_provider", must_not_create_provider)

    with pytest.raises(HTTPException) as exc:
        await ai_routes.test_ai_connection(
            ai_routes.AITestRequest(
                provider="deepseek",
                api_key="__saved__",
                base_url="https://api.deepseek.test/v1",
                model="deepseek-model",
            ),
            db=db_session,
        )

    assert exc.value.status_code == 400
    assert "deepseek" in exc.value.detail
    assert "已保存" in exc.value.detail

    _add_config(db_session, "deepseek", active=False, api_key="deepseek-only-key")
    assert ai_routes._resolve_api_key("__saved__", "deepseek", db_session) == "deepseek-only-key"


async def test_offline_analyze_rejects_non_ollama_provider(monkeypatch, db_session):
    monkeypatch.setenv("APP_MODE", "offline")
    document = _add_document(db_session)
    _add_config(
        db_session,
        "openai",
        active=True,
        api_key="remote-key",
        base_url="http://127.0.0.1:11434/v1",
    )

    def must_not_run(*_args, **_kwargs):
        raise AssertionError("offline rejection must happen before provider creation")

    monkeypatch.setattr(ai_routes, "create_provider", must_not_run)

    with pytest.raises(HTTPException) as exc:
        await ai_routes.ai_analyze(document.id, provider="openai", db=db_session)

    assert exc.value.status_code == 403
    assert "离线版仅允许" in exc.value.detail


async def test_new_config_is_inactive_until_explicitly_enabled(monkeypatch, db_session):
    monkeypatch.setenv("APP_MODE", "online")
    await ai_routes.save_ai_config(
        ai_routes.AIConfigRequest(
            provider="openai",
            api_key="new-key",
            base_url="https://api.openai.test/v1",
            model="test-model",
        ),
        db=db_session,
    )

    config = db_session.query(AIConfig).filter(AIConfig.provider == "openai").one()
    assert config.is_active is False

    await ai_routes.save_ai_config(
        ai_routes.AIConfigRequest(provider="openai", is_active=True),
        db=db_session,
    )
    db_session.refresh(config)
    assert config.is_active is True
