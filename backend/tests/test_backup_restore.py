"""백업 형식·계획·실행·복원 — docker 없이 수행(가짜 실행기 tests/backup_fakes.py).

실제 pg_dump/pg_restore 왕복은 여기서 수행하지 않는다(docs/data-safety.md 의 "검증").
"""

import io
import json
import shutil
import tarfile
from collections import namedtuple
from datetime import datetime, timezone
from pathlib import Path

import pytest

import app.backup.models  # noqa: F401 — db_engine 픽스처의 create_all 전에 등록
from app import cli
from app.backup import format as fmt
from app.backup import plan as pl
from app.backup import runner
from app.backup.format import BackupError
from app.db.schema_version import SCHEMA_VERSION
from tests.backup_fakes import IMAGE, PROJECT, FakeStack

ENV = {"DATABASE_URL": "postgresql+asyncpg://workspace:pw@postgres:5432/workspace", "SECRET_KEY": "original",
       "DOMAIN": "ws.example.com", "APP_URL": "https://ws.example.com", "JW_INSTALL_ID": "inst-1",
       "JW_ZONES": "mail,git"}
Usage = namedtuple("Usage", "total used free")


def quiet(_line: str) -> None:
    return None


@pytest.fixture()
def stack(monkeypatch):
    s = FakeStack()
    monkeypatch.setattr(runner.socket, "gethostname", lambda: s.hostname)
    return s


def make(stack, root: Path, **kw) -> runner.BackupResult:
    kw.setdefault("kind", fmt.KIND_FULL)
    return runner.create_backup(root, runner=stack, env=ENV, log=quiet, **kw)


def restore(stack, path: Path, root: Path, **kw) -> runner.RestoreResult:
    kw.setdefault("migrate", lambda: (1, 1))
    kw.setdefault("env", ENV)
    return runner.restore_backup(path, work_root=root, runner=stack, log=quiet, sleep=lambda _: None,
                                 health_seconds=0, **kw)


# ─── 계획(순수 함수) ───


def cfg(**kw) -> pl.StackConfig:
    base = dict(helper_image=IMAGE, project_dir=PROJECT, config_paths=(".env",), mail_container="ws-mailserver",
                mail_running=True, mail_config_path="mailserver/config", mail_data="ws-mail-data",
                mail_state="ws-mail-state", gitea_container="ws-gitea", gitea_running=True, gitea_data="ws-gitea-data",
                gitea_database="gitea", plugins_data="ws-plugins-data", certs="ws-certbot-data",
                storage="ws-storage-data", db_consumers=("ws-backend", "ws-sso"))
    base.update(kw)
    return pl.StackConfig(**base)


def test_pre_update_plan_is_db_and_config_only():
    plan = pl.plan_backup(cfg(), fmt.KIND_PRE_UPDATE)
    assert plan.items == ["db", "config"] and [s.id for s in plan.steps] == ["db.dump", "config.tar"]
    assert plan.steps[0].argv == ("docker", "exec", "ws-postgres", "pg_dump", "-U", "workspace", "-d", "workspace", "-Fc")
    assert json.loads(json.dumps(plan.to_dict()))["steps"][0]["stdout"] == "db.dump"      # 그대로 JSON 직렬화 가능


def test_full_plan_stops_gitea_around_its_copy_and_skips_files_by_default():
    plan = pl.plan_backup(cfg())
    ids = [s.id for s in plan.steps]
    assert ids[ids.index("gitea.stop"):ids.index("gitea.start") + 1] == [
        "gitea.stop", "gitea.db", "gitea.data", "gitea.start"]
    assert next(s for s in plan.steps if s.id == "gitea.start").always
    assert "files" not in plan.items and plan.skipped["files"] == "not-requested"
    assert "redis" not in " ".join(ids)                                # Redis 는 덤프하지 않음
    assert "files" in pl.plan_backup(cfg(), include_files=True).items


def test_plan_never_includes_files_on_nfs_and_skips_absent_zones():
    plan = pl.plan_backup(cfg(storage_kind="nfs", mail_container="", gitea_container="", app_signing=""),
                          include_files=True)
    assert plan.skipped["files"] == "nfs" and "files" not in plan.items
    assert {"mail", "gitea", "app-signing"} <= set(plan.skipped)
    assert plan.items == ["db", "config", "plugins-data", "certs"]


def test_restore_plan_loads_beside_the_live_database():
    load = pl.plan_db_load(cfg())
    assert "workspace_restore_new" in load[1].argv and "--exit-on-error" in load[1].argv
    swap = " ".join(pl.plan_db_swap(cfg())[0].argv)
    assert 'RENAME TO "workspace_restore_old"' in swap and 'RENAME TO "workspace"' in swap
    assert pl.restore_stops(cfg(), ["db"]) == ["ws-backend", "ws-sso"]
    assert pl.restore_stops(cfg(), ["db", "mail", "gitea"]) == ["ws-backend", "ws-sso", "ws-mailserver", "ws-gitea"]
    assert pl.restore_stops(cfg(), ["certs"]) == []


# ─── 형식 ───


def test_encryption_round_trip_and_wrong_password():
    blob = fmt.encrypt_bytes(b"SECRET_KEY=abc\n", "correct horse")
    assert b"SECRET_KEY" not in blob
    assert fmt.decrypt_bytes(blob, "correct horse") == b"SECRET_KEY=abc\n"
    for bad in ("wrong", ""):
        with pytest.raises(BackupError):
            fmt.decrypt_bytes(blob, bad)
    with pytest.raises(BackupError):
        fmt.decrypt_bytes(blob[:-1] + bytes([blob[-1] ^ 1]), "correct horse")      # 한 비트만 변경되어도


def test_secret_fingerprint_does_not_reveal_the_key():
    fp = fmt.secret_fingerprint("original")
    assert fp == fmt.secret_fingerprint("original") != fmt.secret_fingerprint("other")
    assert "original" not in fp and len(fp) == 16 and fmt.secret_fingerprint("") == ""


def test_full_backup_contents_and_manifest(stack, tmp_path):
    result = make(stack, tmp_path, include_files=True, now=datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc))
    assert result.status == "success" and result.path.name == "20260102_030405-full"
    m = json.loads((result.path / "manifest.json").read_text(encoding="utf-8"))
    assert m["format"] == fmt.FORMAT_VERSION and m["kind"] == "full"
    assert m["schema_version"] == SCHEMA_VERSION and m["product_version"]
    assert m["created_at"] == "2026-01-02T03:04:05+00:00"
    assert m["install_id"] == "inst-1" and m["domain"] == "ws.example.com" and m["zones"] == ["mail", "git"]
    assert m["storage"] == {"kind": "local"} and m["stats"]["users"] == 7 and m["postgres_version"] == 160004
    assert m["secret_key_fingerprint"] == fmt.secret_fingerprint("original")
    assert list(m["items"]) == ["db", "config", "mail", "gitea", "plugins-data", "certs", "files"]
    assert m["skipped"] == {"app-signing": "해당 볼륨이 없습니다"}
    assert {f["role"] for f in m["items"]["mail"]["files"]} == {"config", "data", "state"}
    for entry in fmt.Manifest(m).files():                                # 파일마다 크기·SHA-256
        path = result.path / entry["name"]
        assert entry["size"] == path.stat().st_size and entry["sha256"] == fmt.sha256_file(path)
        assert path.stat().st_mode & 0o077 == 0                          # 소유자만
    assert (result.path / "db.dump").read_bytes() == b"LIVE-DB"
    assert fmt.SECRET_WARNING in m["warnings"]
    # 코드 저장소는 중지 후 재기동됨
    ev = stack.events
    assert ev.index("stop ws-gitea") < ev.index("pg_dump gitea") < ev.index("start ws-gitea")
    assert stack.containers["ws-gitea"]["State"]["Running"]
    assert fmt.verify(fmt.open_backup(result.path)) == []


def test_pre_update_backup_is_small(stack, tmp_path):
    result = make(stack, tmp_path, kind=fmt.KIND_PRE_UPDATE)
    assert sorted(p.name for p in result.path.iterdir()) == ["config.tar", "db.dump", "manifest.json"]
    assert not any(e.startswith("stop") for e in stack.events)


def test_nfs_storage_is_recorded_not_copied(monkeypatch, tmp_path):
    stack = FakeStack(nfs=True)
    monkeypatch.setattr(runner.socket, "gethostname", lambda: stack.hostname)
    result = make(stack, tmp_path, include_files=True)
    assert result.manifest["storage"] == {"kind": "nfs", "server": "nas.example", "export": "/export/jw"}
    assert "files" not in result.manifest["items"] and result.manifest["skipped"]["files"] == "nfs"
    assert "tar-out ws-storage-data" not in stack.events
    summary = fmt.summarize(result.path)
    assert summary["files_included"] is False and summary["storage"]["kind"] == "nfs"


def test_password_protects_the_config_item(stack, tmp_path):
    result = make(stack, tmp_path, password="s3cret-pass")
    assert not (result.path / "config.tar").exists()
    raw = (result.path / "config.tar.enc").read_bytes()
    assert b"SECRET_KEY" not in raw and b".env" not in raw
    backup = fmt.open_backup(result.path)
    assert backup.manifest.config_encrypted
    assert fmt.verify(backup, password="s3cret-pass") == []
    assert any("암호" in p for p in fmt.verify(backup, password="nope"))
    out = tmp_path / "cfg"
    assert ".env" in runner.extract_config(result.path, out, "s3cret-pass")
    assert (out / ".env").read_bytes() == stack.project[".env"]
    with pytest.raises(BackupError):
        runner.extract_config(result.path, tmp_path / "cfg2", None)


# ─── 사전 검사 · 실패 ───


def test_refuses_to_start_without_enough_space(stack, tmp_path, monkeypatch):
    monkeypatch.setattr(runner.shutil, "disk_usage", lambda _p: Usage(10 ** 9, 10 ** 9 - 1000, 1000))
    with pytest.raises(BackupError) as info:
        make(stack, tmp_path)
    assert "여유 공간" in str(info.value)
    assert not any(e.startswith(("pg_dump", "tar-out", "stop")) for e in stack.events)     # 아무 작업도 시작되지 않음
    assert list(tmp_path.iterdir()) == []


def test_refuses_unwritable_destination(stack, tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x")
    with pytest.raises(BackupError) as info:
        make(stack, blocker / "sub")
    assert "쓸 수 없습니다" in str(info.value)


def test_db_dump_failure_fails_the_backup_and_leaves_nothing(stack, tmp_path):
    stack.fail["pg_dump -U workspace -d workspace"] = 1
    with pytest.raises(BackupError) as info:
        make(stack, tmp_path)
    assert "db.dump" in str(info.value) and list(tmp_path.iterdir()) == []
    assert stack.containers["ws-gitea"]["State"]["Running"]            # 중지했던 대상은 재기동됨


def test_other_item_failure_is_reported_as_partial(stack, tmp_path):
    stack.fail["ws-gitea-data:/v:ro"] = 2
    result = make(stack, tmp_path)
    assert result.status == "partial" and "gitea" not in result.manifest["items"]
    assert result.manifest["skipped"]["gitea"] == "failed" and any("gitea.data" in f for f in result.failures)
    assert not (result.path / "gitea-db.dump").exists()                # 불완전한 항목은 남기지 않음
    assert "start ws-gitea" in stack.events
    assert fmt.verify(fmt.open_backup(result.path)) == []


# ─── tar 한 개 · 요약 · 손상 ───


def packed(stack, tmp_path, **kw) -> Path:
    result = make(stack, tmp_path / "b", **kw)
    return fmt.pack(result.path, tmp_path / "moved.jwbak")


def test_pack_puts_manifest_first_and_summary_does_not_read_the_rest(stack, tmp_path):
    archive = packed(stack, tmp_path, include_files=True)
    with tarfile.open(archive) as tar:
        assert tar.getnames()[0] == "manifest.json"
    assert fmt.verify(fmt.open_backup(archive)) == []
    # manifest 멤버까지만 남기고 이후를 무의미한 데이터로 교체해도 요약은 가능 — 나머지를 읽지 않음을 의미
    with tarfile.open(archive) as tar:
        first = tar.next()
        end = first.offset_data + (first.size + 511) // 512 * 512
    cut = tmp_path / "cut.jwbak"
    cut.write_bytes(archive.read_bytes()[:end] + b"garbage, not a tar member " * 400)
    summary = fmt.summarize(cut)
    assert summary["users"] == 7 and summary["schema_version"] == SCHEMA_VERSION
    assert summary["domain"] == "ws.example.com" and summary["source_url"] == "https://ws.example.com"
    assert summary["zones"] == ["mail", "git"] and summary["files_included"] is True and summary["files_bytes"] == 5
    assert summary["storage"] == {"kind": "local"} and summary["kind"] == "full"
    assert summary["config_included"] and not summary["config_encrypted"]


def test_corruption_is_detected(stack, tmp_path):
    result = make(stack, tmp_path / "b")
    archive = fmt.pack(result.path, tmp_path / "ok.jwbak")
    (result.path / "db.dump").write_bytes(b"LIVE-DX")                   # 같은 크기, 다른 내용
    assert any("db.dump" in p and "SHA-256" in p for p in fmt.verify(fmt.open_backup(result.path)))
    (result.path / "mail-data.tar.gz").unlink()
    assert any("mail-data.tar.gz: 파일이 없습니다" in p for p in fmt.verify(fmt.open_backup(result.path)))

    data = bytearray(archive.read_bytes())
    truncated = tmp_path / "short.jwbak"
    truncated.write_bytes(bytes(data[: len(data) // 2]))
    assert fmt.verify(fmt.open_backup(truncated))
    not_backup = tmp_path / "x.jwbak"
    not_backup.write_bytes(b"not a tar at all")
    with pytest.raises(BackupError):
        fmt.open_backup(not_backup)
    newer = json.loads((result.path / "manifest.json").read_text(encoding="utf-8"))
    newer["format"] = fmt.FORMAT_VERSION + 1
    (result.path / "manifest.json").write_text(json.dumps(newer), encoding="utf-8")
    with pytest.raises(BackupError) as info:
        fmt.open_backup(result.path)
    assert "형식 버전" in str(info.value)


def test_extract_rejects_members_outside_the_manifest(stack, tmp_path):
    archive = packed(stack, tmp_path)
    evil = tmp_path / "evil.jwbak"
    shutil.copy(archive, evil)
    with tarfile.open(evil, "a:") as tar:
        info = tarfile.TarInfo("../outside")
        info.size = 1
        tar.addfile(info, io.BytesIO(b"x"))
    backup = fmt.open_backup(evil)
    assert any("manifest 에 없는" in p for p in fmt.verify(backup))
    with pytest.raises(BackupError):
        fmt.extract(backup, tmp_path / "out")
    assert not (tmp_path / "outside").exists()


def test_extract_config_rejects_path_traversal(tmp_path):
    root = tmp_path / "b"
    root.mkdir()
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:") as tar:
        info = tarfile.TarInfo("../../escape")
        info.size = 1
        tar.addfile(info, io.BytesIO(b"x"))
    (root / "config.tar").write_bytes(buf.getvalue())
    manifest = fmt.new_manifest(kind="full", product_version="1", schema_version=1)
    fmt.add_item(manifest, root, "config", [("config.tar", "config")])
    fmt.write_manifest(root, manifest)
    with pytest.raises(BackupError):
        runner.extract_config(root, tmp_path / "out")
    assert not (tmp_path / "escape").exists()


# ─── 복원 ───


def test_restore_from_archive_replaces_everything_and_keeps_a_safety_dump(stack, tmp_path):
    archive = packed(stack, tmp_path, include_files=True)
    shutil.rmtree(tmp_path / "b")
    stack.dbs["workspace"] = b"NEWER-DB"
    stack.volumes.update({"ws-mail-data": b"changed", "ws-storage-data": b"changed", "ws-gitea-data": b"changed"})
    stack.dbs["gitea"] = b"changed"
    stack.project[".env"] = b"SECRET_KEY=original\nEDITED=1\n"
    stack.events.clear()
    calls = []

    result = restore(stack, archive, tmp_path / "work", migrate=lambda: calls.append("migrate") or (1, 1))
    assert stack.dbs["workspace"] == b"LIVE-DB" and stack.dbs["gitea"] == b"GITEA-DB"
    assert stack.volumes["ws-mail-data"] == b"MAILBOXES" and stack.volumes["ws-storage-data"] == b"FILES"
    assert stack.volumes["ws-gitea-data"] == b"REPOS"
    assert stack.project[".env"] == b"SECRET_KEY=original\nEDITED=1\n"            # 설정은 요청 시에만 복원
    assert "config" not in result.items and calls == ["migrate"]
    assert result.stages == ["verify", "compat", "extract", "safety-dump", "stop", "db-load", "db-swap", "migrate",
                             "items", "start", "check"]
    ev = stack.events
    stops = [e for e in ev if e.startswith("stop ")]
    starts = [e for e in ev if e.startswith("start ")]
    assert stops == ["stop ws-backend", "stop ws-sso", "stop ws-mailserver", "stop ws-gitea"]
    assert starts == ["start ws-gitea", "start ws-mailserver", "start ws-sso", "start ws-backend"]
    assert ev.index("stop ws-backend") < ev.index("pg_restore workspace_restore_new") < ev.index("start ws-backend")
    assert ev.index("rename workspace_restore_new→workspace") < ev.index("tar-in ws-mail-data")
    assert set(stack.dbs) == {"workspace", "gitea", "postgres"}                  # 임시 DB 는 남지 않음
    assert Path(result.safety_dump).read_bytes() == b"NEWER-DB"                  # 복원 전 상태
    assert not list((tmp_path / "work").glob("_restore-*"))                      # 작업 폴더도 남지 않음
    assert any("다시 로그인" in n for n in result.notes)


def test_restore_refuses_backup_from_a_newer_schema(stack, tmp_path):
    result = make(stack, tmp_path, kind=fmt.KIND_PRE_UPDATE)
    m = json.loads((result.path / "manifest.json").read_text(encoding="utf-8"))
    m["schema_version"] = SCHEMA_VERSION + 1
    (result.path / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    stack.events.clear()
    with pytest.raises(runner.RestoreError) as info:
        restore(stack, result.path, tmp_path)
    assert info.value.stage == "compat" and "스키마 버전" in info.value.cause
    assert info.value.state == runner.STATE_UNTOUCHED and stack.events == []


def test_restore_applies_pending_steps_for_an_older_backup(stack, tmp_path):
    result = make(stack, tmp_path, kind=fmt.KIND_PRE_UPDATE)
    m = json.loads((result.path / "manifest.json").read_text(encoding="utf-8"))
    m["schema_version"] = 0                                                      # 더 낮은 버전에서 생성한 백업
    (result.path / "manifest.json").write_text(json.dumps(m), encoding="utf-8")
    out = restore(stack, result.path, tmp_path, migrate=lambda: (0, SCHEMA_VERSION))
    assert (out.schema_from, out.schema_to) == (0, SCHEMA_VERSION)


def test_restore_refuses_corrupted_backup_before_touching_anything(stack, tmp_path):
    result = make(stack, tmp_path, kind=fmt.KIND_PRE_UPDATE)
    (result.path / "db.dump").write_bytes(b"LIVE-DX")
    stack.events.clear()
    with pytest.raises(runner.RestoreError) as info:
        restore(stack, result.path, tmp_path)
    assert info.value.stage == "verify" and stack.events == [] and stack.dbs["workspace"] == b"LIVE-DB"


def test_restore_checks_the_encryption_key(stack, tmp_path):
    result = make(stack, tmp_path, kind=fmt.KIND_PRE_UPDATE)
    other = {**ENV, "SECRET_KEY": "a-different-key"}
    with pytest.raises(runner.RestoreError) as info:
        restore(stack, result.path, tmp_path, env=other)
    assert info.value.stage == "compat" and "암호화 키" in info.value.cause
    restore(stack, result.path, tmp_path, env=other, allow_key_mismatch=True)

    stack.project[".env"] = b"SECRET_KEY=a-different-key\n"
    out = restore(stack, result.path, tmp_path, env=other, with_config=True)     # 설정까지 복원하면 키도 복원됨
    assert out.config_restored and stack.project[".env"] == b"SECRET_KEY=original\nDB_PASSWORD=pw\n"
    assert any("docker compose up -d" in n for n in out.notes)
    assert not list(tmp_path.glob("_restore-*"))                                 # 압축 해제한 설정은 남기지 않음


def test_restore_needs_the_password_for_protected_config(stack, tmp_path):
    result = make(stack, tmp_path, kind=fmt.KIND_PRE_UPDATE, password="pw-1234")
    restore(stack, result.path, tmp_path)                                        # 설정을 변경하지 않으면 암호 불필요
    for bad in (None, "wrong"):
        with pytest.raises(runner.RestoreError) as info:
            restore(stack, result.path, tmp_path, with_config=True, password=bad)
        assert info.value.stage == "verify"
    assert restore(stack, result.path, tmp_path, with_config=True, password="pw-1234").config_restored


def test_failed_load_leaves_the_live_database_alone(stack, tmp_path):
    result = make(stack, tmp_path, kind=fmt.KIND_PRE_UPDATE)
    stack.dbs["workspace"] = b"NEWER-DB"
    stack.fail["pg_restore"] = 1
    with pytest.raises(runner.RestoreError) as info:
        restore(stack, result.path, tmp_path)
    assert info.value.stage == "db-load" and info.value.state == runner.STATE_UNTOUCHED
    assert stack.dbs["workspace"] == b"NEWER-DB" and "workspace_restore_new" not in stack.dbs
    assert all(stack.containers[c]["State"]["Running"] for c in ("ws-backend", "ws-sso"))   # 재기동됨
    assert "db-load" not in info.value.done and "stop" in info.value.done


def test_failed_migration_rolls_the_database_back(stack, tmp_path):
    result = make(stack, tmp_path, kind=fmt.KIND_PRE_UPDATE)
    stack.dbs["workspace"] = b"NEWER-DB"

    def boom():
        raise RuntimeError("단계 2 실패")

    with pytest.raises(runner.RestoreError) as info:
        restore(stack, result.path, tmp_path, migrate=boom)
    assert info.value.stage == "migrate" and "단계 2 실패" in info.value.cause
    assert info.value.state == runner.STATE_ROLLED_BACK
    assert stack.dbs["workspace"] == b"NEWER-DB"                                 # 복원 전 상태 유지
    assert set(stack.dbs) == {"workspace", "gitea", "postgres"}
    assert stack.containers["ws-backend"]["State"]["Running"]


def test_failed_swap_is_undone(stack, tmp_path):
    result = make(stack, tmp_path, kind=fmt.KIND_PRE_UPDATE)
    stack.dbs["workspace"] = b"NEWER-DB"
    stack.fail['RENAME TO "workspace_restore_old"'] = 1
    with pytest.raises(runner.RestoreError) as info:
        restore(stack, result.path, tmp_path)
    assert info.value.stage == "db-swap" and stack.dbs["workspace"] == b"NEWER-DB"
    assert "workspace_restore_new" not in stack.dbs and stack.containers["ws-backend"]["State"]["Running"]


def test_item_failure_is_reported_and_services_come_back(stack, tmp_path):
    result = make(stack, tmp_path)
    stack.dbs["workspace"] = b"NEWER-DB"
    stack.fail["ws-mail-data:/v"] = 2
    with pytest.raises(runner.RestoreError) as info:
        restore(stack, result.path, tmp_path)
    assert info.value.stage == "items" and "mail.data" in info.value.cause
    assert "workspace_restore_old" in info.value.state                           # 복원 전 DB 의 위치를 안내
    assert stack.dbs["workspace"] == b"LIVE-DB" and stack.dbs["workspace_restore_old"] == b"NEWER-DB"
    assert all(c["State"]["Running"] for c in stack.containers.values())


def test_unhealthy_backend_after_restore_is_a_failure(stack, tmp_path):
    result = make(stack, tmp_path, kind=fmt.KIND_PRE_UPDATE)
    stack.containers["ws-backend"]["State"]["Health"]["Status"] = "unhealthy"
    with pytest.raises(runner.RestoreError) as info:
        restore(stack, result.path, tmp_path)
    assert info.value.stage == "check" and "ws-backend" in info.value.cause


def test_restore_refuses_to_run_inside_the_backend_it_must_stop(monkeypatch, tmp_path):
    stack = FakeStack(hostname="ws-backend")
    monkeypatch.setattr(runner.socket, "gethostname", lambda: "ws-backend")
    result = make(stack, tmp_path, kind=fmt.KIND_PRE_UPDATE)
    stack.events.clear()
    with pytest.raises(runner.RestoreError) as info:
        restore(stack, result.path, tmp_path)
    assert info.value.stage == "compat" and "scripts/restore.sh" in info.value.cause and stack.events == []


def test_restore_only_selected_items_does_not_stop_the_backend(stack, tmp_path):
    result = make(stack, tmp_path)
    stack.volumes["ws-certbot-data"] = b"changed"
    stack.events.clear()
    out = restore(stack, result.path, tmp_path, items=["certs"])
    assert out.items == ["certs"] and stack.volumes["ws-certbot-data"] == b"CERTS"
    assert not any(e.startswith(("stop", "pg_")) for e in stack.events) and out.safety_dump == ""


# ─── CLI · 관리 화면 ───


@pytest.fixture()
def cli_stack(stack, monkeypatch, tmp_path):
    monkeypatch.setattr(runner, "SubprocessRunner", lambda: stack)
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setenv("BACKUP_ROOT", str(tmp_path))
    return stack


def test_cli_create_inspect_verify_list(cli_stack, tmp_path, capsys):
    assert cli.main(["backup", "create", "--kind", "pre-update", "--pack", "--json"]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["status"] == "success" and out["path"].endswith(".jwbak") and out["is_archive"]
    assert cli.main(["backup", "inspect", out["path"], "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["items"] == ["db", "config"]
    assert cli.main(["backup", "verify", out["path"]]) == 0
    assert cli.main(["backup", "list", "--json"]) == 0
    assert len(json.loads(capsys.readouterr().out.split("\n", 1)[1])) == 1

    data = Path(out["path"]).read_bytes()
    Path(out["path"]).write_bytes(data[: len(data) // 2])                        # 전송 중 중단된 파일
    assert cli.main(["backup", "verify", out["path"]]) == 1
    assert cli.main(["backup", "inspect", str(tmp_path / "nope.jwbak")]) == 1


def test_cli_partial_backup_exit_code(cli_stack, capsys):
    cli_stack.fail["ws-mail-state:/v:ro"] = 2
    assert cli.main(["backup", "create"]) == 2
    assert "mail.state" in capsys.readouterr().err


def test_cli_restore_reports_stage_and_exit_code(cli_stack, tmp_path, capsys, monkeypatch):
    assert cli.main(["backup", "create", "--kind", "pre-update", "--json"]) == 0
    path = json.loads(capsys.readouterr().out)["path"]
    assert cli.main(["restore", path]) == 2                                      # 확인 없이는 수행하지 않음
    assert "--yes" in capsys.readouterr().err

    monkeypatch.setattr(runner, "_default_migrate", lambda: (1, 1))
    monkeypatch.setattr(runner.time, "sleep", lambda _: None)
    cli_stack.fail["pg_restore"] = 1
    assert cli.main(["restore", path, "--yes", "--json", "--health-timeout", "0"]) == 1
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {"ok": False, "stage": "db-load", "state": runner.STATE_UNTOUCHED,
                                        "error": json.loads(captured.out)["error"],
                                        "done": ["verify", "compat", "extract", "safety-dump", "stop"]}
    assert "단계 'db-load'" in captured.err

    cli_stack.fail.clear()
    assert cli.main(["restore", path, "--yes", "--json", "--health-timeout", "0"]) == 0
    assert json.loads(capsys.readouterr().out)["ok"] is True
    assert cli.main(["restore", path, "--yes", "--items", "nope"]) == 2


async def test_admin_backup_records_honest_status(db_session, stack, tmp_path, monkeypatch):
    from app.backup import service

    monkeypatch.setattr(service, "BACKUP_ROOT", tmp_path)
    monkeypatch.setattr(runner, "SubprocessRunner", lambda: stack)
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)

    rec = await service.run_backup(db_session, kind="manual", user_id="u1")
    assert rec.status == "success" and Path(rec.path).is_dir() and rec.size_bytes > 0
    comps = json.loads(rec.components)
    assert comps["db"] == "ok" and comps["files"] == "ok" and comps["app-signing"].startswith("skip")
    assert service.verify_record(rec) == []

    stack.fail["ws-certbot-data:/v:ro"] = 2
    rec = await service.run_backup(db_session, kind="manual")
    assert rec.status == "partial" and json.loads(rec.components)["certs"] == "fail" and "certs.data" in rec.error

    stack.fail["pg_dump -U workspace -d workspace"] = 1
    rec = await service.run_backup(db_session, kind="scheduled")
    assert rec.status == "failed" and "DB 를 뜨지 못했습니다" in rec.error and rec.path == ""

    assert await service.delete_backup(db_session, rec.id) is True


def test_no_in_app_restore_endpoint():
    """앱 내부의 복원 API 는 없다 — 복원은 backend 를 중지하고 수행하는 작업이므로 CLI·설치 관리자만 수행한다."""
    from app.setup import router as setup_router

    paths = {r.path for r in setup_router.router.routes}
    assert "/api/setup/status" in paths
    assert not [p for p in paths if "restore" in p]
