"""설치 후 사용하는 `jw` 명령 — 동일 서버로의 복원(`jw restore`), 업데이트 채널의 공개 키와 주소."""

from __future__ import annotations

import io
import json

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec

from app import api_update, cli
from app import restore_local as rl
from app import update_release as rel
from app.docker_api import Result
from tests.update_harness import UpdateHost

SUMMARY = {"created_at": "2026-01-10T03:00:00Z", "product_version": "1.0.0", "schema_version": 2, "domain": "ws.example.com",
           "install_id": "11111111-2222-3333-4444-555555555555", "zones": ["mail", "chat"], "users": 3,
           "items": ["db", "config", "mail", "files"], "skipped": {"gitea": "구역 없음"}, "files_included": True,
           "size_bytes": 5 * 1024 * 1024, "kind": "full"}


@pytest.fixture()
def host(tmp_path, monkeypatch) -> UpdateHost:
    host = UpdateHost(tmp_path, monkeypatch)
    host.manager()
    monkeypatch.setattr(cli, "_services", lambda args: host.svc)
    host.restore_calls = []
    host.restore_reply = json.dumps({"ok": True, "items": ["db", "mail", "files"], "schema": [1, 2],
                                     "safety_dump": "/backups/_pre-restore/20260112_013000.dump", "notes": []}) + "\n"

    def restore(argv, _):
        host.restore_calls.append(list(argv))
        host.flag_seen.append((host.paths.stack / "nginx/state/maintenance.on").exists())
        return host.restore_reply

    host.runner.on("compose", "run", "backend", "backup", "inspect", out=json.dumps(SUMMARY, indent=2) + "\n")
    host.runner.on("compose", "run", "backend", "backup", "list",
                   out=json.dumps([{"path": "/backups/20260110_030000-full", **SUMMARY}], indent=2) + "\n")
    host.runner.on("compose", "run", "backend", "app.cli", "restore", fn=restore)
    return host


# ─── jw restore ───


def test_restore_shows_the_backup_first_and_changes_nothing_without_yes(host, capsys):
    assert cli.main(["restore", "/srv/backups/full.jwbak"]) == 1
    out = capsys.readouterr().out
    assert "ws.example.com" in out and "db, mail, files" in out and "gitea" in out and "--yes" in out
    assert "config" not in out.split("되돌릴 항목:")[1].splitlines()[0]         # 설정은 복원하지 않는다
    assert host.restore_calls == []
    inspect = host.runner.find("compose", "run", "backend", "backup", "inspect")[0]
    assert "/srv/backups/full.jwbak:/restore-src:ro" in inspect and "/restore-src" in inspect
    assert any(a.endswith("run-network.yml") for a in inspect)                # 실행 중인 backend 의 고정 주소와 충돌하지 않도록 한다


def test_restore_runs_the_backend_restore_under_maintenance(host, capsys):
    assert cli.main(["restore", "/srv/backups/full.jwbak", "--yes"]) == 0
    out = capsys.readouterr().out
    argv = host.restore_calls[0]
    at = argv.index("backend")
    assert argv[at + 1:] == ["-m", "app.cli", "restore", "/restore-src", "--yes", "--json"]
    assert "--user" in argv[:at] and argv[argv.index("--user") + 1] == "0"
    assert "/srv/backups/full.jwbak:/restore-src:ro" in argv[:at]
    assert "--with-config" not in argv                                         # 설정은 설치 관리자 소관이다
    assert host.flag_seen == [True]                                            # 실행 중에는 쓰기를 차단한다
    assert not (host.paths.stack / "nginx/state/maintenance.on").exists()      # 종료 시 해제한다
    assert "되돌렸습니다: db, mail, files" in out and "1 → 2" in out and "_pre-restore" in out and "다시 로그인" in out


def test_restore_from_the_backup_volume_by_name_with_items_and_password(host, capsys):
    (host.paths.data / "pass.txt").write_text("secret\n", encoding="utf-8")
    assert cli.main(["restore", "20260110_030000-full", "--items", "db,mail", "--password-file", "/opt/just-workspace/pass.txt",
                     "--allow-key-mismatch", "--yes", "--json"]) == 0
    argv = host.restore_calls[0]
    at = argv.index("backend")
    assert argv[at + 1:] == ["-m", "app.cli", "restore", "/backups/20260110_030000-full", "--yes", "--json", "--items", "db,mail",
                             "--allow-key-mismatch", "--password-file", "/restore-pass"]
    assert "/opt/just-workspace/pass.txt:/restore-pass:ro" in argv[:at]
    assert not any(":/restore-src:ro" in a for a in argv)                      # 볼륨 내부의 것은 별도로 마운트하지 않는다
    assert "secret" not in " ".join(argv)                                      # 암호는 명령에 포함하지 않는다
    printed = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]
    assert printed and printed[0]["ok"] is True


def test_restore_reports_the_failed_stage_and_exits_nonzero(host, capsys):
    host.restore_reply = Result(1, json.dumps({"ok": False, "stage": "migrate", "error": "단계 2 실패",
                                               "state": "원래 DB 로 되돌렸습니다", "done": ["verify"]}) + "\n", "ERROR: 복원 실패")
    assert cli.main(["restore", "/srv/backups/full.jwbak", "--yes"]) == 1
    err = capsys.readouterr().err
    assert "단계 'migrate'" in err and "단계 2 실패" in err and "원래 DB 로 되돌렸습니다" in err
    assert not (host.paths.stack / "nginx/state/maintenance.on").exists()

    host.restore_reply = Result(137, "", "Killed")                             # 결과 없이 종료되었다
    assert cli.main(["restore", "/srv/backups/full.jwbak", "--yes"]) == 1
    assert "종료 코드 137" in capsys.readouterr().err


def test_restore_is_not_reported_done_while_backend_is_down(host, capsys):
    host.running.discard("ws-backend")
    assert cli.main(["restore", "/srv/backups/full.jwbak", "--yes"]) == 1
    assert "아직 준비되지 않았습니다" in capsys.readouterr().out


@pytest.mark.parametrize("argv, text", [
    (["restore"], "백업을 지정하세요"),
    (["restore", "../etc"], "경로가 올바르지 않습니다"),
    (["restore", "/srv/a b.jwbak"], "경로가 올바르지 않습니다"),
    (["restore", "/etc/shadow"], "경로가 올바르지 않습니다"),
    (["restore", "na;me"], "백업 이름이 올바르지 않습니다"),
    (["restore", "/srv/backups/full.jwbak", "--items", "gitea", "--yes"], "백업에 없는 항목"),
])
def test_restore_refusals(host, capsys, argv, text):
    assert cli.main(argv) == 1
    assert text in capsys.readouterr().err
    assert host.restore_calls == []


def test_restore_refused_before_install_and_while_busy(host, capsys):
    host.install_keys()
    host.releases.publish("1.0.0")
    host.releases.publish("1.0.1")
    mgr = api_update.manager(host.svc)
    mgr.check()
    mgr._spawn = lambda job_id: None
    mgr.apply("1.0.1", "countdown", None)
    assert cli.main(["restore", "/srv/backups/full.jwbak", "--yes"]) == 1
    assert "업데이트 작업이 진행 중" in capsys.readouterr().err
    mgr._set_active(None)
    host.svc.store.set_phase("wizard")
    assert cli.main(["restore", "/srv/backups/full.jwbak", "--yes"]) == 1
    assert "백업에서 복원" in capsys.readouterr().err
    assert host.restore_calls == []


def test_restore_unreadable_backup_and_list(host, capsys):
    assert cli.main(["restore", "--list"]) == 0
    assert "20260110_030000-full" in capsys.readouterr().out
    host.runner.on("compose", "run", "backend", "backup", "inspect", rc=1, err="ERROR: manifest.json 이 없습니다")
    assert cli.main(["restore", "/srv/backups/x.tar", "--yes"]) == 1
    err = capsys.readouterr().err
    assert "백업을 읽지 못했습니다" in err and "manifest.json" in err
    assert host.restore_calls == []


def test_container_paths_map_to_host_paths():
    from pathlib import Path

    from app.paths import Paths

    paths = Paths(data=Path("/data"), host_dir="/opt/just-workspace", bundle=None)
    assert rl.resolve_source(paths, "/data/backups/a.jwbak").run_args == ("-v", "/opt/just-workspace/backups/a.jwbak:/restore-src:ro")
    assert rl.resolve_source(paths, "/opt/just-workspace/a.jwbak").run_args == ("-v", "/opt/just-workspace/a.jwbak:/restore-src:ro")
    assert rl.resolve_source(paths, "name.jwbak") == rl.Source("volume", "/backups/name.jwbak", ())


# ─── jw update-key · update-channel ───


def pem_of(key) -> bytes:
    return key.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo)


def test_update_key_add_list_remove(host, capsys, tmp_path, monkeypatch):
    keys = host.paths.state / "update" / "keys"
    assert cli.main(["update-key"]) == 0
    assert "공개 키가 없습니다" in capsys.readouterr().out

    pub = tmp_path / "release.pem"
    pub.write_bytes(host.releases.public_pem)
    assert cli.main(["update-key", "add", str(pub)]) == 0
    out = capsys.readouterr().out
    assert (keys / "release.pub").read_bytes() == host.releases.public_pem
    assert "지문" in out and "state/update/keys" in out
    assert rel.load_keys(host.svc.store.dir)

    # 표준 입력으로도 수신한다 — 둘째 키(다음 키)
    second = pem_of(ec.generate_private_key(ec.SECP256R1()))
    monkeypatch.setattr("sys.stdin", type("S", (), {"buffer": io.BytesIO(second)})())
    assert cli.main(["update-key", "add", "-", "--name", "next"]) == 0
    assert (keys / "next.pub").read_bytes() == second
    capsys.readouterr()

    third = tmp_path / "third.pub"
    third.write_bytes(pem_of(ec.generate_private_key(ec.SECP256R1())))
    assert cli.main(["update-key", "add", str(third)]) == 1                    # 최대 둘(현재·다음)
    assert "2개까지" in capsys.readouterr().err and not (keys / "third.pub").exists()

    assert cli.main(["update-key", "remove", "next.pub"]) == 0
    assert not (keys / "next.pub").exists()
    assert cli.main(["update-key", "remove", "../release.pub"]) == 1


def test_update_key_rejects_what_is_not_a_public_key(host, capsys, tmp_path):
    keys = host.paths.state / "update" / "keys"
    private = ec.generate_private_key(ec.SECP256R1()).private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    for name, body, text in (("priv.pem", private, "비공개 키"), ("junk.pub", b"hello", "공개 키가 아닙니다"),
                             ("big.pub", b"x" * 20000, "공개 키 파일이 아닙니다")):
        path = tmp_path / name
        path.write_bytes(body)
        assert cli.main(["update-key", "add", str(path)]) == 1
        assert text in capsys.readouterr().err
    assert cli.main(["update-key", "add", str(tmp_path / "nope.pub")]) == 1
    assert not keys.exists() or not list(keys.iterdir())


def test_update_key_makes_the_check_work(host):
    """키가 없어 "구성되지 않음"이던 서버에 키를 추가하면 확인이 수행된다."""
    host.releases.publish("1.0.0")
    host.releases.publish("1.0.1")
    mgr = host.manager()
    mgr.check()
    assert mgr.status()["check"]["error"]["code"] == "unconfigured"
    pub = host.paths.data / "release.pub"
    pub.write_bytes(host.releases.public_pem)
    assert cli.main(["update-key", "add", str(pub)]) == 0
    mgr = host.manager()
    mgr.check()
    st = mgr.status()
    assert st["check"]["ok"] is True and st["available"]["version"] == "1.0.1"


def test_update_channel_show_set_reset(host, capsys):
    host.install_keys()
    assert cli.main(["update-channel"]) == 0
    assert "https://releases.example.com" in capsys.readouterr().out

    # 다른 채널로 전환 — 새 채널의 순번이 낮아도(다른 발행자) 수용하도록 저장된 순번을 삭제한다
    host.releases.publish("1.0.0")
    host.releases.publish("1.0.1")
    mgr = host.manager()
    mgr.check()
    assert mgr.check_raw()["sequence"]
    assert cli.main(["update-channel", "https://mirror.example.com/jw/"]) == 0
    assert "https://mirror.example.com/jw" in capsys.readouterr().out
    assert (host.svc.store.dir / rel.CHANNEL_URL_FILE).read_text(encoding="utf-8") == "https://mirror.example.com/jw\n"
    mgr = host.manager()
    assert mgr.check_raw()["sequence"] == {}
    host.releases.fetched.clear()
    mgr.check()
    assert mgr.status()["check"]["error"]["code"] == "channel_unreachable"     # 모의 채널에는 해당 주소가 없다
    assert host.releases.fetched[0] == "https://mirror.example.com/jw/channels/stable.json"

    for bad in ("ftp://x.example.com", "mirror.example.com", "https://user:pw@x.example.com", "https://x.example.com/?a=1",
                "https://"):
        assert cli.main(["update-channel", bad]) == 1
    capsys.readouterr()
    assert cli.main(["update-channel", "--reset"]) == 0
    assert not (host.svc.store.dir / rel.CHANNEL_URL_FILE).exists()
    assert "https://releases.example.com" in capsys.readouterr().out
    mgr = host.manager()
    host.releases.fetched.clear()
    mgr.check()
    assert host.releases.fetched[0] == "https://releases.example.com/channels/stable.json" and mgr.status()["check"]["ok"] is True
