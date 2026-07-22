# This file is part of the Official Document AI Assistant.
# (c) 2026 Jose AI (https://www.linhut.cn)
# Licensed under the MIT License. See the LICENSE file for details.

"""
HaoXiang Document Assistant - FastAPI 后端入口

启动参数:
  --port PORT    监听端口 (默认 8765)
  --force        端口被占用时自动杀死旧进程
"""
import argparse
import atexit
from contextlib import asynccontextmanager
import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.routes import documents, check, optimize, ai, settings, templates, rules, template_download, office
from config import API_PORT, get_app_mode, is_offline_mode
from db.database import init_db
from utils.logger import logger

HOST = "127.0.0.1"
DEFAULT_PORT = API_PORT
APP_ID = "official-document-ai-assistant"
APP_VERSION = "1.4.7"


# ---------------------------------------------------------------------------
# 端口占用检测 & 旧进程清理
# ---------------------------------------------------------------------------

def _find_windows_pid_on_port(port: int) -> int | None:
    """Use the existing Windows netstat lookup to find one listening PID."""
    try:
        output = subprocess.check_output(
            ["netstat", "-ano"], text=True, stderr=subprocess.DEVNULL,
        )
        for line in output.splitlines():
            parts = line.split()
            if len(parts) < 5 or parts[0].upper() != "TCP":
                continue
            if parts[-2].upper() != "LISTENING":
                continue

            try:
                local_port = int(parts[1].rsplit(":", 1)[1])
                pid = int(parts[-1])
            except (IndexError, ValueError):
                continue

            if local_port == port and pid > 0:
                return pid
    except Exception:
        pass
    return None


def _linux_listening_socket_inodes(
    port: int,
    proc_root: Path | str = "/proc",
) -> set[str]:
    """Return socket inodes listening on *port* from Linux procfs."""
    inodes: set[str] = set()
    proc_root = Path(proc_root)

    for table_name in ("tcp", "tcp6"):
        table_path = proc_root / "net" / table_name
        try:
            lines = table_path.read_text(encoding="ascii", errors="replace").splitlines()
        except OSError:
            continue

        for line in lines[1:]:
            fields = line.split()
            if len(fields) <= 9 or fields[3] != "0A":
                continue

            try:
                local_port = int(fields[1].rsplit(":", 1)[1], 16)
            except (IndexError, ValueError):
                continue

            inode = fields[9]
            if local_port == port and inode != "0":
                inodes.add(inode)

    return inodes


def _linux_pids_for_socket_inodes(
    socket_inodes: set[str],
    proc_root: Path | str = "/proc",
) -> list[int]:
    """Resolve Linux socket inodes to owning PIDs through /proc/<pid>/fd."""
    if not socket_inodes:
        return []

    proc_root = Path(proc_root)
    pids: set[int] = set()
    try:
        process_dirs = list(proc_root.iterdir())
    except OSError:
        return []

    for process_dir in process_dirs:
        if not process_dir.name.isdigit():
            continue

        try:
            fd_entries = list((process_dir / "fd").iterdir())
        except OSError:
            continue

        for fd_entry in fd_entries:
            try:
                target = os.readlink(fd_entry)
            except OSError:
                continue

            if target.startswith("socket:[") and target.endswith("]"):
                inode = target[len("socket:["):-1]
                if inode in socket_inodes:
                    pids.add(int(process_dir.name))
                    break

    return sorted(pids)


def _find_pids_on_port(port: int) -> list[int]:
    """Find processes listening on a TCP port on supported desktop platforms."""
    if sys.platform == "win32":
        pid = _find_windows_pid_on_port(port)
        return [pid] if pid is not None else []
    if sys.platform.startswith("linux"):
        inodes = _linux_listening_socket_inodes(port)
        return _linux_pids_for_socket_inodes(inodes)
    return []


def _find_pid_on_port(port: int) -> int | None:
    """Return the first listening PID for compatibility with existing callers."""
    pids = _find_pids_on_port(port)
    return pids[0] if pids else None


def _kill_pid(pid: int) -> bool:
    """Terminate a stale backend process using platform-native APIs."""
    if sys.platform == "win32":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            return True
        except subprocess.CalledProcessError:
            return False
    if sys.platform.startswith("linux"):
        try:
            os.kill(pid, signal.SIGTERM)
            return True
        except ProcessLookupError:
            return True
        except (PermissionError, OSError):
            return False
    return False


def _is_port_available(port: int) -> bool:
    """Check whether the backend can bind its loopback IPv4 endpoint."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((HOST, port))
        except OSError:
            return False
    return True


def _wait_for_port_release(port: int, attempts: int = 30, delay: float = 0.1) -> bool:
    for _ in range(attempts):
        if _is_port_available(port):
            return True
        time.sleep(delay)
    return _is_port_available(port)


def _get_local_backend_health(port: int, timeout: float = 1.0) -> dict[str, object] | None:
    """Read a bounded health response directly from the loopback port."""
    connection = http.client.HTTPConnection(HOST, port, timeout=timeout)
    try:
        connection.request("GET", "/api/health")
        response = connection.getresponse()
        if response.status != 200:
            return None
        raw_body = response.read(64 * 1024 + 1)
        if len(raw_body) > 64 * 1024:
            return None
        payload = json.loads(raw_body.decode("utf-8"))
        return payload if isinstance(payload, dict) else None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, http.client.HTTPException):
        return None
    finally:
        connection.close()


def _is_compatible_local_backend(health: dict[str, object] | None) -> bool:
    """Accept only this application's exact backend build and runtime mode."""
    return bool(
        health
        and health.get("status") == "ok"
        and health.get("app_id") == APP_ID
        and health.get("version") == APP_VERSION
        and health.get("app_mode") == get_app_mode()
    )


def _check_and_free_port(port: int, force: bool) -> None:
    """
    检测端口是否被占用；--force 时自动释放，否则报错退出。
    同时注册 atexit 钩子确保当前进程退出时清理端口。
    """
    if _is_port_available(port):
        return

    pids = _find_pids_on_port(port)

    if not force:
        msg = f"端口 {port} 已被占用"
        if pids:
            msg += f"（PID {', '.join(str(pid) for pid in pids)}）"
        msg += "。请先关闭旧进程，或使用 --force 自动释放。"
        print(f"[startup] ERROR: {msg}", file=sys.stderr)
        sys.exit(1)

    health = _get_local_backend_health(port)
    if not _is_compatible_local_backend(health):
        if health is None:
            identity = "无法验证 /api/health"
        else:
            identity = (
                f"app_id={health.get('app_id', 'unknown')}, "
                f"version={health.get('version', 'unknown')}, "
                f"app_mode={health.get('app_mode', 'unknown')}"
            )
        print(
            f"[startup] ERROR: 端口 {port} 的占用进程与当前后端不兼容或身份未验证"
            f"（{identity}）；为避免终止其他进程，后端已停止启动。",
            file=sys.stderr,
        )
        sys.exit(1)

    failed_pids: list[int] = []
    for pid in pids:
        print(f"[startup] --force: 终止占用端口 {port} 的进程 PID {pid} ...")
        if not _kill_pid(pid):
            failed_pids.append(pid)

    if _wait_for_port_release(port):
        print(f"[startup] 端口 {port} 已释放。")
        return

    if not pids:
        detail = "无法确定占用进程 PID"
    elif failed_pids:
        detail = f"无法终止 PID {', '.join(str(pid) for pid in failed_pids)}"
    else:
        detail = "终止进程后端口仍被占用"
    print(
        f"[startup] ERROR: --force 无法释放端口 {port}（{detail}），后端已停止启动。",
        file=sys.stderr,
    )
    sys.exit(1)


def _setup_signal_handlers() -> None:
    """注册信号处理，确保 Ctrl+C 时优雅退出。"""
    def _shutdown(signum, frame):
        print("\n[shutdown] 收到终止信号，正在关闭...")
        sys.exit(0)

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)


# ---------------------------------------------------------------------------
# FastAPI App
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    _init_default_ai_config()
    _log_directory_status()
    if not is_offline_mode():
        from services.model_health import start_health_checker
        await start_health_checker()
    try:
        yield
    finally:
        from services.model_health import stop_health_checker
        await stop_health_checker()


app = FastAPI(
    title="HaoXiang Document Assistant",
    description="HaoXiang 本地公文助手核心引擎 API",
    version=APP_VERSION,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8765",
        "http://127.0.0.1:8765",
        "file://",
    ],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(documents.router, prefix="/api/documents", tags=["documents"])
app.include_router(check.router, prefix="/api/check", tags=["check"])
app.include_router(optimize.router, prefix="/api/optimize", tags=["optimize"])
app.include_router(ai.router, prefix="/api/ai", tags=["ai"])
app.include_router(settings.router, prefix="/api/settings", tags=["settings"])
app.include_router(templates.router, prefix="/api/templates", tags=["templates"])
app.include_router(rules.router, prefix="/api/rules", tags=["rules"])
app.include_router(template_download.router, prefix="/api/template", tags=["template_download"])
app.include_router(office.router, prefix="/api/office", tags=["office"])


def _log_directory_status():
    """启动时打印关键目录状态，便于排查打包问题。"""
    from config import RULES_DIR, UPLOAD_DIR, BASE_DIR
    from pathlib import Path

    dirs_to_check = {
        "BASE_DIR": BASE_DIR,
        "RULES_DIR": RULES_DIR,
        "UPLOAD_DIR": UPLOAD_DIR,
    }
    for name, d in dirs_to_check.items():
        exists = d.exists()
        count = len(list(d.glob("*"))) if exists else 0
        print(f"[startup] {name}: {d} (exists={exists}, items={count})")

    # 检查规则文件
    yaml_count = len(list(RULES_DIR.glob("*.yaml"))) if RULES_DIR.exists() else 0
    print(f"[startup] Rule YAML files: {yaml_count}")
    if yaml_count == 0:
        print(f"[startup] WARNING: No rule YAML files found at {RULES_DIR}!")
        print(f"[startup] Templates will show 'has_rules: false' and document check will return no issues.")


def _read_default_ai_config_env() -> tuple[str, str, str] | None:
    """Return an explicit default AI config without selecting a remote endpoint."""
    api_key = os.environ.get("DEFAULT_AI_API_KEY", "").strip()
    base_url = os.environ.get("DEFAULT_AI_BASE_URL", "").strip()
    model = os.environ.get("DEFAULT_AI_MODEL", "gpt-4o-mini").strip() or "gpt-4o-mini"
    if not api_key or not base_url:
        return None
    return api_key, base_url, model


def _init_default_ai_config():
    """启动时自动初始化显式提供的默认 AI 配置。"""
    if is_offline_mode():
        logger.info("Offline mode: skipping default cloud AI config creation")
        return

    default_values = _read_default_ai_config_env()
    if default_values is None:
        logger.info(
            "DEFAULT_AI_API_KEY and DEFAULT_AI_BASE_URL must both be set; "
            "skipping default AI config creation"
        )
        return
    default_api_key, default_base_url, default_model = default_values

    try:
        from db.database import SessionLocal
        from db.models import AIConfig
        from utils.crypto import encrypt_value

        db = SessionLocal()
        try:
            # 精确查询 custom（内置默认）provider
            existing = db.query(AIConfig).filter(AIConfig.provider == "custom").first()
            if not existing:
                # 无配置 → 创建默认
                new_config = AIConfig(
                    provider="custom",
                    api_key_encrypted=encrypt_value(default_api_key),
                    base_url=default_base_url,
                    model=default_model,
                    is_active=True,
                )
                db.add(new_config)
                db.commit()
                logger.info(f"Default AI config created: custom @ {default_base_url}")
            else:
                # 有配置但字段不完整 → 补全
                changed = False
                if not existing.base_url:
                    existing.base_url = default_base_url
                    changed = True
                if not existing.model:
                    existing.model = default_model
                    changed = True
                if changed:
                    db.commit()
                    logger.info("Fixed incomplete AI config")
                else:
                    print(f"[startup] AI config: {existing.provider} @ {existing.base_url} (active={existing.is_active})")
        finally:
            db.close()
    except Exception as e:
        print(f"[startup] AI config init error: {e}")


@app.get("/")
async def root():
    return {
        "app": "HaoXiang Document Assistant",
        "version": app.version,
        "app_mode": get_app_mode(),
        "docs": "/docs",
        "health": "/api/health"
    }


@app.get("/api/health")
async def health_check():
    return {
        "status": "ok",
        "app_id": APP_ID,
        "version": app.version,
        "app_mode": get_app_mode(),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="HaoXiang Document Assistant 后端")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="监听端口")
    parser.add_argument("--force", action="store_true", help="端口被占用时自动杀死旧进程")
    args = parser.parse_args()

    bind_host = HOST

    _setup_signal_handlers()
    _check_and_free_port(args.port, force=args.force)

    uvicorn.run(app, host=bind_host, port=args.port)
