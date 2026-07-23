import json
from pathlib import Path

import pytest

import main


PROC_NET_HEADER = (
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when "
    "retrnsmt   uid  timeout inode\n"
)


def _proc_socket_row(local_address: str, state: str, inode: str) -> str:
    return (
        f"   0: {local_address} 00000000:0000 {state} "
        f"00000000:00000000 00:00000000 00000000 1000 0 {inode}\n"
    )


def _compatible_health() -> dict[str, str]:
    return {
        "status": "ok",
        "app_id": main.APP_ID,
        "version": main.APP_VERSION,
        "app_mode": main.get_app_mode(),
    }


def test_windows_pid_lookup_matches_exact_local_port(monkeypatch):
    netstat_output = "\n".join(
        [
            "  TCP    127.0.0.1:87650      0.0.0.0:0      LISTENING       111",
            "  TCP    [::1]:8765           [::]:0         LISTENING       222",
            "  TCP    127.0.0.1:8765       0.0.0.0:0      ESTABLISHED     333",
        ]
    )
    monkeypatch.setattr(
        main.subprocess,
        "check_output",
        lambda *args, **kwargs: netstat_output,
    )

    assert main._find_windows_pid_on_port(8765) == 222


def test_backend_identity_version_matches_desktop_package():
    package_path = Path(__file__).resolve().parents[2] / "frontend" / "package.json"
    package = json.loads(package_path.read_text(encoding="utf-8"))

    assert main.APP_ID == "official-document-ai-assistant"
    assert main.APP_VERSION == package["version"]


@pytest.mark.asyncio
async def test_health_response_exposes_complete_backend_identity(monkeypatch):
    monkeypatch.setenv("APP_MODE", "offline")

    payload = await main.health_check()

    assert payload == {
        "status": "ok",
        "app_id": main.APP_ID,
        "version": main.APP_VERSION,
        "app_mode": "offline",
    }


def test_linux_listening_socket_inodes_reads_ipv4_and_ipv6(tmp_path):
    net_dir = tmp_path / "net"
    net_dir.mkdir()
    (net_dir / "tcp").write_text(
        PROC_NET_HEADER
        + _proc_socket_row("0100007F:223D", "0A", "111")
        + _proc_socket_row("0100007F:223D", "01", "ignored-established")
        + _proc_socket_row("0100007F:1234", "0A", "ignored-port"),
        encoding="ascii",
    )
    (net_dir / "tcp6").write_text(
        PROC_NET_HEADER
        + _proc_socket_row(
            "0000000000000000FFFF00000100007F:223D",
            "0A",
            "222",
        )
        + _proc_socket_row("00000000000000000000000000000000:223D", "0A", "0"),
        encoding="ascii",
    )

    assert main._linux_listening_socket_inodes(8765, tmp_path) == {"111", "222"}


def test_linux_pids_for_socket_inodes_resolves_fake_proc_fds(tmp_path, monkeypatch):
    matching_fd = tmp_path / "321" / "fd" / "4"
    duplicate_fd = tmp_path / "321" / "fd" / "5"
    second_pid_fd = tmp_path / "654" / "fd" / "7"
    unrelated_fd = tmp_path / "777" / "fd" / "9"
    for fd_path in (matching_fd, duplicate_fd, second_pid_fd, unrelated_fd):
        fd_path.parent.mkdir(parents=True, exist_ok=True)
        fd_path.touch()
    (tmp_path / "not-a-pid").mkdir()
    (tmp_path / "888").mkdir()

    link_targets = {
        matching_fd: "socket:[111]",
        duplicate_fd: "socket:[222]",
        second_pid_fd: "socket:[222]",
        unrelated_fd: "socket:[999]",
    }

    def fake_readlink(path):
        target = link_targets.get(Path(path))
        if target is None:
            raise OSError("fd disappeared")
        return target

    monkeypatch.setattr(main.os, "readlink", fake_readlink)

    assert main._linux_pids_for_socket_inodes({"111", "222"}, tmp_path) == [321, 654]


def test_port_availability_allows_immediate_restart_after_closed_connections(monkeypatch):
    calls: list[tuple[object, ...]] = []

    class FakeSocket:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def setsockopt(self, *args):
            calls.append(("setsockopt", *args))

        def bind(self, address):
            calls.append(("bind", address))

    monkeypatch.setattr(main.socket, "socket", lambda *_args: FakeSocket())

    assert main._is_port_available(8765) is True
    assert calls == [
        ("setsockopt", main.socket.SOL_SOCKET, main.socket.SO_REUSEADDR, 1),
        ("bind", (main.HOST, 8765)),
    ]


def test_force_exits_when_killed_process_does_not_release_port(monkeypatch, capsys):
    monkeypatch.setattr(main, "_is_port_available", lambda port: False)
    monkeypatch.setattr(main, "_find_pids_on_port", lambda port: [4321])
    monkeypatch.setattr(main, "_get_local_backend_health", lambda port: _compatible_health())
    monkeypatch.setattr(main, "_kill_pid", lambda pid: True)
    monkeypatch.setattr(main, "_wait_for_port_release", lambda port: False)

    with pytest.raises(SystemExit) as exc_info:
        main._check_and_free_port(8765, force=True)

    assert exc_info.value.code == 1
    error = capsys.readouterr().err
    assert "端口 8765" in error
    assert "终止进程后端口仍被占用" in error
    assert "后端已停止启动" in error


def test_force_exits_when_port_owner_cannot_be_resolved(monkeypatch, capsys):
    monkeypatch.setattr(main, "_is_port_available", lambda port: False)
    monkeypatch.setattr(main, "_find_pids_on_port", lambda port: [])
    monkeypatch.setattr(main, "_get_local_backend_health", lambda port: _compatible_health())
    monkeypatch.setattr(main, "_wait_for_port_release", lambda port: False)

    with pytest.raises(SystemExit) as exc_info:
        main._check_and_free_port(8765, force=True)

    assert exc_info.value.code == 1
    assert "无法确定占用进程 PID" in capsys.readouterr().err


@pytest.mark.parametrize(
    "health",
    [
        None,
        {
            "status": "ok",
            "app_id": main.APP_ID,
            "version": "1.4.6",
            "app_mode": "offline",
        },
        {
            "status": "ok",
            "app_id": main.APP_ID,
            "version": main.APP_VERSION,
            "app_mode": "online",
        },
        {
            "status": "ok",
            "app_id": "another-service",
            "version": main.APP_VERSION,
            "app_mode": "offline",
        },
    ],
)
def test_force_never_kills_unverified_or_incompatible_port_owner(
    health,
    monkeypatch,
    capsys,
):
    killed_pids: list[int] = []
    monkeypatch.setenv("APP_MODE", "offline")
    monkeypatch.setattr(main, "_is_port_available", lambda port: False)
    monkeypatch.setattr(main, "_find_pids_on_port", lambda port: [4321])
    monkeypatch.setattr(main, "_get_local_backend_health", lambda port: health)
    monkeypatch.setattr(main, "_kill_pid", lambda pid: killed_pids.append(pid) or True)

    with pytest.raises(SystemExit) as exc_info:
        main._check_and_free_port(8765, force=True)

    assert exc_info.value.code == 1
    assert killed_pids == []
    error = capsys.readouterr().err
    assert "为避免终止其他进程" in error
    assert "后端已停止启动" in error
