"""
conftest.py — 为测试添加 backend 目录到 sys.path
"""
import sys
import asyncio
import inspect
from pathlib import Path

# 将 backend/ 加入 Python path
_backend = Path(__file__).resolve().parent.parent / "backend"
if str(_backend) not in sys.path:
    sys.path.insert(0, str(_backend))


def pytest_configure(config):
    config.addinivalue_line("markers", "asyncio: run async test with the stdlib asyncio loop")


def pytest_pyfunc_call(pyfuncitem):
    if inspect.iscoroutinefunction(pyfuncitem.obj):
        kwargs = {
            name: pyfuncitem.funcargs[name]
            for name in pyfuncitem._fixtureinfo.argnames
        }
        asyncio.run(pyfuncitem.obj(**kwargs))
        return True
    return None
