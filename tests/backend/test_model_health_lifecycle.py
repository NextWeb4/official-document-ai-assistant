import asyncio

from services import model_health


async def test_health_checker_start_is_idempotent_and_stop_awaits_task(monkeypatch):
    calls = 0
    entered = asyncio.Event()

    async def fake_checks():
        nonlocal calls
        calls += 1
        entered.set()

    monkeypatch.setattr(model_health, "_run_all_checks", fake_checks)
    monkeypatch.setattr(model_health, "_CHECK_INTERVAL", 3600)
    model_health._check_task = None

    await model_health.start_health_checker()
    first_task = model_health._check_task
    await model_health.start_health_checker()
    await asyncio.wait_for(entered.wait(), timeout=1)

    assert model_health._check_task is first_task
    assert calls == 1

    await model_health.stop_health_checker()

    assert model_health._check_task is None
    assert first_task is not None
    assert first_task.done()
