"""업데이트 엔진 — 확인·계획, 단계와 실패 분기, 롤백, 자기 교체, 자동 업데이트, 복원 지점, 기록."""

from __future__ import annotations

import json
from datetime import timedelta

import pytest

from app import update_release as rel
from app import update_swap
from app.update_engine import KEEP_POINTS, UpdateError, pull_percent
from jwrelease import sign
from tests.update_harness import BASE, T0, Killed, UpdateHost, run_to_end


@pytest.fixture()
def host(tmp_path, monkeypatch) -> UpdateHost:
    return UpdateHost(tmp_path, monkeypatch)


def ready(host: UpdateHost, *versions: str, **publish):
    """키를 설치하고 릴리스를 게시한 뒤 확인까지 완료한 엔진."""
    host.install_keys()
    for version in versions:
        host.releases.publish(version, **publish)
    mgr = host.manager()
    mgr.check()
    return mgr


def steps(job: dict) -> dict:
    return {s["id"]: s["status"] for s in job["steps"]}


# ─── 확인 · 계획 ───


def test_check_without_public_key_is_unconfigured(host):
    host.releases.publish("1.0.1")
    mgr = host.manager()
    mgr.check()
    st = mgr.status()
    assert st["check"]["ok"] is False and st["check"]["error"]["code"] == "unconfigured"
    assert st["available"] == {"state": "none"}
    assert host.releases.fetched == []                # 키가 없으면 조회 자체를 수행하지 않는다


def test_check_finds_update_and_sends_nothing_but_gets(host):
    mgr = ready(host, "1.0.0", "1.0.1")
    available = mgr.status()["available"]
    assert available["state"] == "update" and available["version"] == "1.0.1" and available["path"] == ["1.0.1"]
    assert available["channel"] == "stable" and available["changelog"] == "- 1.0.1 의 변경"
    assert available["download_bytes"] is None and available["downtime_seconds"] == 240
    assert available["auto_eligible_at"] == rel.utc_iso(T0 - timedelta(days=7))
    assert {z["id"] for z in available["zones"]} >= {"core", "mail"}
    assert available["plugin_warnings"] == []
    assert host.releases.fetched[0] == f"{BASE}/channels/stable.json"
    assert all(url.startswith(BASE) and "?" not in url for url in host.releases.fetched)
    assert mgr.check_raw()["sequence"]["stable"] == host.releases.channels["stable"].sequence
    assert mgr.settings_raw()["next_check_at"] > mgr.iso()         # 다음 확인은 6시간 후(+지터)


def test_plan_none_wait_blocked_and_path(host):
    mgr = ready(host, "1.0.0")
    assert mgr.status()["available"] == {"state": "none"}
    host.releases.publish("1.1.0", min_upgrade_from="1.0.5")
    mgr.check()
    blocked = mgr.status()["available"]
    assert blocked == {"state": "blocked", "version": "1.1.0",
                       "reason": {"code": "no_upgrade_path", "vars": {"min_upgrade_from": "1.0.5"}}}
    host.releases.publish("1.0.5")
    mgr.check()
    assert mgr.status()["available"]["path"] == ["1.0.5", "1.1.0"]
    # Beta 사용 후 Stable 로 복귀한 직후 — 채널의 최신 버전이 현재보다 낮다
    mgr._write("current.json", {"version": "1.2.0-beta.1", "applied_at": None, "previous_version": None})
    mgr.check()
    assert mgr.status()["available"] == {"state": "wait", "channel_latest": "1.1.0", "resume_from": "1.2.0"}


def test_download_bytes_sums_the_path(host):
    host.install_keys()
    host.releases.publish("1.0.5", download_bytes=1000)
    host.releases.publish("1.1.0", min_upgrade_from="1.0.5", download_bytes=234)
    mgr = host.manager()
    mgr.check()
    assert mgr.status()["available"]["download_bytes"] == 1234


@pytest.mark.parametrize("case, code, kind", [
    ("tampered", "channel_invalid", "signature"),
    ("other_key", "channel_invalid", "signature"),
    ("expired", "channel_invalid", "expired"),
    ("rollback", "channel_invalid", "rollback"),
    ("manifest_tampered", "manifest_invalid", "hash"),
    ("manifest_resigned", "manifest_invalid", "hash"),
    ("unreachable", "channel_unreachable", ""),
])
def test_check_rejects_bad_channel_and_keeps_last_good_result(host, case, code, kind):
    from cryptography.hazmat.primitives.asymmetric import ec

    mgr = ready(host, "1.0.0", "1.0.1")
    good = mgr.status()["available"]
    files = host.releases.files
    if case == "tampered":
        files[f"{BASE}/channels/stable.json"] = files[f"{BASE}/channels/stable.json"].replace(b"1.0.1", b"9.0.1")
    elif case == "other_key":
        host.releases.write_channel("stable", key=ec.generate_private_key(ec.SECP256R1()))
    elif case == "expired":
        host.clock = T0 + timedelta(days=91)
    elif case == "rollback":
        old = dict(files)
        host.releases.publish("1.0.2")
        mgr.check()
        good = mgr.status()["available"]
        files.clear()
        files.update(old)                              # 이전 채널 파일을 다시 제공한다
    elif case == "manifest_tampered":
        host.releases.publish("1.0.2")
        files[f"{BASE}/releases/1.0.2/manifest.json"] += b" "
    elif case == "manifest_resigned":
        host.releases.publish("1.0.2")
        raw = files[f"{BASE}/releases/1.0.2/manifest.json"].replace(b"backend@sha256:", b"backend@sha256:0")[:-2] + b"}\n"
        files[f"{BASE}/releases/1.0.2/manifest.json"] = raw
        files[f"{BASE}/releases/1.0.2/manifest.json.sig"] = sign.sign_bytes(raw, host.releases.key)
    else:
        host.releases.down = True
    mgr.check()
    st = mgr.status()
    assert st["check"]["ok"] is False and st["check"]["error"]["code"] == code
    assert st["check"]["error"].get("kind", "") == kind
    assert st["available"] == good                    # 실패한 확인은 마지막 성공 결과를 삭제하지 않는다


def test_two_public_keys_current_and_next(host):
    from cryptography.hazmat.primitives.asymmetric import ec

    next_key = ec.generate_private_key(ec.SECP256R1())
    host.install_keys(name="1-current.pub")
    host.install_keys(sign.public_key_pem(next_key), name="2-next.pub")
    host.releases.publish("1.0.1", key=next_key)       # 다음 키로 서명한 릴리스도 수용한다
    mgr = host.manager()
    mgr.check()
    assert mgr.status()["available"]["version"] == "1.0.1"


def test_window_and_pull_percent():
    assert rel.in_window("03:00", "05:00", 3 * 60) and rel.in_window("03:00", "05:00", 4 * 60 + 59)
    assert not rel.in_window("03:00", "05:00", 5 * 60) and not rel.in_window("03:00", "05:00", 2 * 60 + 59)
    assert rel.in_window("23:00", "02:00", 23 * 60 + 30) and rel.in_window("23:00", "02:00", 60)
    assert not rel.in_window("23:00", "02:00", 12 * 60)
    assert pull_percent({}) == 0
    assert pull_percent({"a": "Pull complete", "b": "Downloading", "c": "Already exists", "d": "Waiting"}) == 50


# ─── 적용 ───


def test_manual_update_runs_all_steps_and_hands_over_to_the_new_installer(host):
    mgr = ready(host, "1.0.0", "1.0.1", db_schema=2)
    with pytest.raises(Killed):                       # switch 종료 시점에 이전 설치 관리자가 종료된다
        mgr.apply("1.0.1", "now", {"id": "u1", "name": "관리자"})
    job = mgr.active()
    assert steps(job) == {"preflight": "done", "backup": "done", "pull": "done", "migrate": "done",
                          "switch": "running", "verify": "pending"}
    assert job["ctx"]["handoff"]["state"] == "pending" and job["ctx"]["handoff"]["to"] == "1.0.1"
    assert host.env_version() == "1.0.1" and mgr.maintenance()["active"] is True
    swap = host.runner.find("run", "app.update_swap")[0]
    assert swap[swap.index("--image") + 1] == "localhost/just-workspace-installer:1.0.1"
    assert swap[swap.index("--expect-version") + 1] == "1.0.1" and "/var/run/docker.sock:/var/run/docker.sock" in swap

    new = host.manager(own_version="1.0.1")           # 새 설치 관리자가 기동되어 작업을 인계받는다
    assert new.resume() is True
    job = new.job_raw(job["id"])
    assert job["status"] == "done" and set(steps(job).values()) == {"done"}
    assert new.active() is None and new.maintenance()["active"] is False
    assert new.current() == {"version": "1.0.1", "applied_at": new.iso(), "previous_version": "1.0.0"}
    assert new.status()["available"] == {"state": "none"}
    assert host.schema == 2 and job["steps"][-1]["detail"] == {"version": "1.0.1", "schema_version": 2}

    r = host.runner
    order = [r.index("exec", "ws-backend", "backup", "create"), r.index("pull"), r.index("compose", "run", "backend", "migrate"),
             r.index("run", "app.update_restack"), r.index("compose", "up", "frontend-react"),
             r.index("compose", "up", "--force-recreate", "nginx"), r.index("compose", "up", "backend"),
             r.index("run", "app.update_swap")]
    assert order == sorted(order)                      # backend 는 맨 마지막, 그 뒤에 설치 관리자
    pulled = [c[-1] for c in r.find("pull")]
    assert pulled[0].startswith("registry.example.com/jw/just-workspace-installer@sha256:")     # 번들을 포함한 이미지부터
    assert any(p.startswith("onlyoffice/documentserver@") for p in pulled)                      # 활성 구역의 외부 이미지(third-party)
    assert not any("gitea" in p for p in pulled)                                                # 비활성 구역은 pull 하지 않는다
    assert "localhost/just-workspace-backend:1.0.1" in host.images
    migrate = r.find("compose", "run", "backend", "migrate")[0]
    assert migrate.count("--env-file") == 2            # .env 에 새 버전만 덮어써 새 backend 이미지로 실행한다

    assert host.flag_seen == [True]                    # 백업 생성 전에 점검 모드 진입
    assert not mgr.flag_path().exists()
    assert host.event_types() == ["maintenance", "finished"]
    assert host.posts[0]["_key"] and host.posts[-1]["result"] == "success" and host.posts[-1]["version"] == "1.0.1"

    row = new.history()["items"][0]
    assert row["id"] == job["id"] and row["result"] == "success" and row["trigger"] == "manual"
    assert row["version"] == "1.0.1" and row["from_version"] == "1.0.0" and row["actor"] == {"id": "u1", "name": "관리자"}
    detail = new.history_entry(job["id"])
    assert [s["id"] for s in detail["versions"][0]["steps"]] == list(steps(job))
    point = new.restore_points()["points"][0]
    assert point["kind"] == "pre-update" and point["version"] == "1.0.0" and point["size_bytes"] == 73400320
    assert (new.dir / "snapshots" / point["id"] / "stack" / ".env").read_text(encoding="utf-8").count("1.0.0") == 2
    notes = new.release_notes("1.0.1")
    assert notes["previous_version"] == "1.0.0" and notes["trigger"] == "manual" and notes["disabled_plugins"] == []
    assert any("[swap]" in line or "이어받았습니다" in line for line in new.read_log(job["id"]))
    with pytest.raises(UpdateError):
        new.release_notes("3.0.0")


def test_countdown_cancel_and_start_now(host):
    mgr = ready(host, "1.0.0", "1.0.1")
    spawn, mgr._spawn = mgr._spawn, lambda job_id: None          # 사전 공지 상태에서 정지시켜 둔다
    job = mgr.apply("1.0.1", "countdown", None)
    assert job["status"] == "countdown" and job["countdown"]["seconds"] == 300
    assert mgr.maintenance() == {"active": False, "phase": "countdown", "kind": "update", "started_at": None,
                                 "expected_seconds": 240, "countdown_ends_at": job["countdown"]["ends_at"],
                                 "contact": None}
    with pytest.raises(UpdateError) as e:
        mgr.action(job["id"], "retry", None)
    assert e.value.code == "action_not_allowed" and e.value.vars["allowed"] == ["start_now", "cancel"]
    with pytest.raises(UpdateError) as e:
        mgr.apply("1.0.1", "now", None)
    assert e.value.code == "busy" and e.value.vars["job"] == job["id"]
    mgr._spawn = spawn
    cancelled = mgr.action(job["id"], "cancel", None)
    assert cancelled["status"] == "cancelled" and mgr.active() is None
    assert host.event_types() == ["countdown", "cancelled"]
    assert mgr.history()["items"][0]["result"] == "cancelled"
    assert host.runner.find("exec", "ws-backend", "backup", "create") == []

    mgr._spawn = lambda job_id: None
    job = mgr.apply("1.0.1", "countdown", None)
    mgr._spawn = spawn
    with pytest.raises(Killed):
        mgr.action(job["id"], "start_now", None)
    assert mgr.active()["status"] == "running" and host.event_types()[-2:] == ["countdown", "maintenance"]


def test_countdown_runs_out_and_starts(host):
    mgr = ready(host, "1.0.0", "1.0.1")
    with pytest.raises(Killed):
        mgr.apply("1.0.1", "countdown", None)
    job = mgr.active()
    assert job["status"] == "running" and job["maintenance_started_at"] == rel.utc_iso(T0 + timedelta(seconds=300))


def test_apply_guards(host):
    mgr = ready(host, "1.0.0")
    with pytest.raises(UpdateError) as e:
        mgr.apply("1.0.1", "now", None)
    assert e.value.code == "not_available"
    host.releases.publish("1.0.1")
    host.releases.publish("1.0.2")
    mgr.check()
    with pytest.raises(UpdateError) as e:
        mgr.apply("1.0.1", "now", None)
    assert e.value.code == "target_stale" and e.value.vars["target"] == "1.0.2"
    host.svc.store.set_phase("applying")
    with pytest.raises(UpdateError) as e:
        mgr.apply("1.0.2", "now", None)
    assert e.value.code == "not_installed"


def test_preflight_fails_on_low_disk_and_schema_downgrade(host):
    mgr = ready(host, "1.0.0", "1.0.1")
    mgr.free_bytes = lambda: 10
    job = mgr.apply("1.0.1", "now", None)
    assert job["status"] == "failed" and job["error"]["cause"] == "no_space" and job["error"]["step"] == "preflight"
    assert job["choices"] == ["retry", "rollback"]
    mgr.free_bytes = lambda: 100 * 1024 ** 3
    host.schema = 5
    job = mgr.action(job["id"], "retry", None)
    assert job["error"]["cause"] == "schema_downgrade"


# ─── 실패 분기 ───


def test_pull_failure_waits_for_choice_then_retry(host):
    mgr = ready(host, "1.0.0", "1.0.1")
    host.fail_pull = {"just-workspace-backend@"}
    job = mgr.apply("1.0.1", "now", None)
    assert job["status"] == "failed" and job["choices"] == ["retry", "rollback"] and job["rollback_job"] is None
    assert job["error"]["step"] == "pull" and job["error"]["cause"] == "image_pull_failed"
    assert job["error"]["vars"]["image"] == "backend"
    images = {i["name"]: i["status"] for i in job["steps"][2]["detail"]["images"]}
    assert images["installer"] == "done" and images["backend"] == "failed"
    assert mgr.maintenance()["active"] is True and mgr.status()["job"]["id"] == job["id"]      # 선택 대기 중에는 점검 모드 유지
    assert host.env_version() == "1.0.0" and host.event_types() == ["maintenance"]
    host.fail_pull = set()
    with pytest.raises(Killed):
        mgr.action(job["id"], "retry", None)
    assert len(host.runner.find("exec", "ws-backend", "backup", "create")) == 1                # 완료된 단계는 재실행되지 않는다
    mgr, _ = run_to_end(host, mgr, lambda m: m.active())
    assert mgr.job_raw(job["id"])["status"] == "done" and mgr.current()["version"] == "1.0.1"


def test_pull_failure_then_rollback_changes_nothing(host):
    mgr = ready(host, "1.0.0", "1.0.1")
    host.fail_pull = {"just-workspace-backend@"}
    job = mgr.apply("1.0.1", "now", None)
    out = mgr.action(job["id"], "rollback", None)
    assert out["id"] == job["id"] and out["rollback_job"] and out["choices"] == []
    rb = mgr.job_raw(out["rollback_job"])
    assert rb["kind"] == "rollback" and rb["status"] == "done" and rb["parent_job"] == job["id"]
    assert rb["from_version"] == "1.0.1" and rb["target_version"] == "1.0.0"
    assert [s["id"] for s in rb["steps"]] == ["stop", "images", "restore_db", "start", "verify"]
    assert rb["steps"][0]["detail"] == {"skipped": True} and rb["steps"][2]["detail"] == {"skipped": True}
    assert host.runner.find("compose", "stop") == [] and host.runner.find("compose", "run", "backend", "restore") == []
    assert mgr.active() is None and mgr.maintenance()["active"] is False and mgr.current()["version"] == "1.0.0"
    row = mgr.history_entry(job["id"])
    assert row["result"] == "rolled_back" and row["version"] == "1.0.0" and row["rollback"]["result"] == "done"
    assert len(mgr.history()["items"]) == 1            # 롤백은 별도 기록 행을 생성하지 않는다
    assert host.posts[-1]["type"] == "finished" and host.posts[-1]["result"] == "rolled_back"
    assert host.posts[-1]["failed_step"] == "pull"
    assert mgr.status()["available"]["state"] == "update"      # 적용 가능한 버전은 그대로 유지된다


def test_migrate_failure_rolls_back_automatically_with_db_restore(host):
    mgr = ready(host, "1.0.0", "1.0.1", db_schema=2)
    host.fail_migrate = True
    job = mgr.apply("1.0.1", "now", None)
    assert job["status"] == "failed" and job["choices"] == [] and job["error"]["step"] == "migrate"
    assert job["error"]["cause"] == "database_migrate_failed" and "column does not exist" in job["error"]["detail"]
    rb = mgr.job_raw(job["rollback_job"])              # 실패한 작업의 응답에 롤백 작업이 이미 포함되어 있다
    assert rb["status"] == "done" and set(steps(rb).values()) == {"done"}
    r = host.runner
    restore = r.find("compose", "run", "backend", "restore")[0]
    assert restore[restore.index("restore") + 1] == host.backups[0] and "--yes" in restore and "db" in restore
    stop = r.find("compose", "stop")[0]
    assert "backend" in stop and "mailserver" in stop and not {"postgres", "redis", "nginx"} & set(stop[stop.index("stop"):])
    order = [r.index("compose", "stop"), r.index("compose", "run", "backend", "restore"),
             r.index("compose", "up", "--force-recreate", "nginx"), r.index("compose", "up", "backend")]
    assert order == sorted(order)
    assert host.schema == 1 and host.env_version() == "1.0.0" and mgr.current()["version"] == "1.0.0"
    assert r.find("run", "app.update_swap") == []      # 설치 관리자는 아직 교체되지 않았다 — 롤백 대상도 없다
    assert mgr.history_entry(job["id"])["result"] == "rolled_back"
    assert mgr.status()["auto"]["paused"] is False     # 수동 업데이트의 실패는 자동 업데이트를 일시 중지시키지 않는다


def test_verify_failure_in_new_installer_rolls_back_and_swaps_installer_back(host):
    # 설치 관리자 기동 시 사용자가 지정한 환경변수 — 복원 지점에 기록해 두었다가 롤백 시 그대로 사용한다
    host.runner.on("container", "inspect", "jw-self", out=json.dumps([{
        "Image": "sha256:selfimage", "NetworkSettings": {"Networks": {}},
        "Config": {"Env": ["PATH=/usr/bin", "JW_UPDATE_CHANNEL_URL=https://mirror.example.com", "JW_INSTALLER_VERSION=1.0.0"]}}]))
    host.runner.on("image", "inspect", "sha256:selfimage", out=json.dumps([{"Id": "sha256:selfimage",
                                                                           "Config": {"Env": ["PATH=/usr/bin"]}}]))
    mgr = ready(host, "1.0.0", "1.0.1", db_schema=2)
    with pytest.raises(Killed):
        mgr.apply("1.0.1", "now", None)
    job_id = mgr.active()["id"]
    host.http.responses["http://backend:8000/api/health"] = 500
    new = host.manager(own_version="1.0.1")
    with pytest.raises(Killed):                        # 롤백의 start 종료 시점에 새 설치 관리자가 종료된다
        new.resume()
    job = new.job_raw(job_id)
    assert job["error"]["step"] == "verify" and job["error"]["cause"] == "health_check_failed"
    rb = new.active()
    assert rb["id"] == job["rollback_job"] and steps(rb)["start"] == "running"
    back = host.runner.find("run", "app.update_swap")[-1]
    assert back[back.index("--image") + 1] == "sha256:selfimage" and back[back.index("--expect-version") + 1] == "1.0.0"
    assert "--env-json" in back and "--env-json" not in host.runner.find("run", "app.update_swap")[0]
    assert json.loads((new.dir / "swap-env.json").read_text(encoding="utf-8")) == ["JW_UPDATE_CHANNEL_URL=https://mirror.example.com"]
    host.http.responses.clear()
    old = host.manager(own_version="1.0.0")
    old.resume()
    assert old.job_raw(rb["id"])["status"] == "done" and old.current()["version"] == "1.0.0" and host.schema == 1
    assert old.history_entry(job_id)["result"] == "rolled_back"


def test_installer_replace_failure_is_recorded_by_the_old_installer(host):
    mgr = ready(host, "1.0.0", "1.0.1")
    with pytest.raises(Killed):
        mgr.apply("1.0.1", "now", None)
    job_id = mgr.active()["id"]
    (mgr.dir / "swap-result.json").write_text(json.dumps({"ok": False, "error": "new container not ready"}))
    old = host.manager(own_version="1.0.0")            # 보조 컨테이너가 이전 컨테이너를 복원했다
    old.resume()
    job = old.job_raw(job_id)
    assert job["error"]["step"] == "switch" and job["error"]["cause"] == "installer_replace_failed"
    assert job["error"]["detail"] == "new container not ready"
    assert old.job_raw(job["rollback_job"])["status"] == "done" and host.env_version() == "1.0.0"


def test_installer_replace_timeout_fails_the_step(host):
    mgr = ready(host, "1.0.0", "1.0.1")
    host.swap = "none"
    job = mgr.apply("1.0.1", "now", None)
    assert job["error"]["cause"] == "installer_replace_failed" and job["error"]["detail"] == "timeout"
    assert mgr.job_raw(job["rollback_job"])["status"] == "done"


def test_rollback_failure_is_reported_honestly_and_can_be_retried(host):
    mgr = ready(host, "1.0.0", "1.0.1", db_schema=2)
    host.fail_migrate = host.fail_restore = True
    job = mgr.apply("1.0.1", "now", None)
    rb = mgr.job_raw(job["rollback_job"])
    assert rb["status"] == "failed" and rb["choices"] == ["retry"]
    assert rb["error"]["step"] == "restore_db" and rb["error"]["cause"] == "db_restore_failed"
    assert rb["error"]["vars"]["backup_location"] == host.backups[0] and rb["error"]["vars"]["manual"] == "restore_manually"
    assert mgr.maintenance()["active"] is True and mgr.maintenance()["kind"] == "rollback"
    assert mgr.status()["job"]["id"] == rb["id"]
    assert mgr.history_entry(job["id"])["result"] == "rollback_failed"
    assert "finished" not in host.event_types()
    host.fail_restore = False
    done = mgr.action(rb["id"], "retry", None)
    assert done["status"] == "done" and mgr.history_entry(job["id"])["result"] == "rolled_back"
    assert host.runner.find("compose", "stop").__len__() == 1      # 완료된 단계는 재실행되지 않는다


def test_interrupted_step_is_rerun_after_installer_restart(host):
    mgr = ready(host, "1.0.0", "1.0.1")
    host.fail_pull = {"just-workspace-backend@"}
    job = mgr.apply("1.0.1", "now", None)
    raw = mgr.job_raw(job["id"])
    raw.update(status="running", error=None, choices=[])
    raw["steps"][2]["status"] = "running"              # pull 도중 설치 관리자가 비정상 종료되었다
    mgr._save(raw)
    host.fail_pull = set()
    again = host.manager()
    with pytest.raises(Killed):
        again.resume()
    assert again.job_raw(job["id"])["steps"][2].get("interrupted") is True
    assert steps(again.job_raw(job["id"]))["migrate"] == "done"


# ─── 중간 버전 ───


def test_intermediate_versions_each_get_a_backup(host):
    host.install_keys()
    host.releases.publish("1.0.1", db_schema=2)
    host.releases.publish("1.0.2", min_upgrade_from="1.0.1", db_schema=3)
    mgr = host.manager()
    mgr.check()
    assert mgr.status()["available"]["path"] == ["1.0.1", "1.0.2"]
    assert mgr.status()["available"]["downtime_seconds"] == 480
    mgr, job_id = run_to_end(host, mgr, lambda m: m.apply("1.0.2", "now", None))
    job = mgr.job_raw(job_id)
    assert job["status"] == "done" and job["version_index"] == 1 and mgr.own_version == "1.0.2"
    assert len(host.backups) == 2 and host.schema == 3
    points = mgr.restore_points()["points"]
    assert [p["version"] for p in points] == ["1.0.1", "1.0.0"]
    assert mgr.current() == {"version": "1.0.2", "applied_at": mgr.iso(), "previous_version": "1.0.1"}
    detail = mgr.history_entry(job_id)
    assert [v["version"] for v in detail["versions"]] == ["1.0.1", "1.0.2"] and detail["version"] == "1.0.2"
    assert mgr.release_notes("1.0.1")["version"] == "1.0.1"


def test_failure_at_second_version_rolls_back_to_the_first(host):
    host.install_keys()
    host.releases.publish("1.0.1", db_schema=2)
    host.releases.publish("1.0.2", min_upgrade_from="1.0.1", db_schema=3)
    mgr = host.manager()
    mgr.check()
    with pytest.raises(Killed):
        mgr.apply("1.0.2", "now", None)
    host.fail_migrate = True                            # 둘째 버전의 DB 변경이 실패한다
    mgr, job_id = run_to_end(host, mgr, lambda m: m.active())
    job = mgr.job_raw(job_id)
    assert job["status"] == "failed" and job["version_index"] == 1 and job["error"]["step"] == "migrate"
    rb = mgr.job_raw(job["rollback_job"])
    assert rb["status"] == "done" and rb["target_version"] == "1.0.1" and rb["from_version"] == "1.0.2"
    assert mgr.current()["version"] == "1.0.1" and host.schema == 2 and host.env_version() == "1.0.1"
    row = mgr.history_entry(job_id)
    assert row["result"] == "rolled_back" and row["version"] == "1.0.1"       # 실제로 도달한 버전
    assert [v["version"] for v in row["versions"]] == ["1.0.1", "1.0.2"]


# ─── 자동 업데이트 ───


def auto_host(host, published_days_ago: float, hour_utc: int = 19):
    """자동 방식, 릴리스는 published_days_ago 일 전 공개. 서버 시간은 UTC+9 — 19:00 UTC = 04:00."""
    host.clock = T0.replace(hour=hour_utc, minute=0)
    host.install_keys()
    host.releases.publish("1.0.1", published=host.clock - timedelta(days=published_days_ago), now=host.clock)
    mgr = host.manager()
    mgr.put_settings({"mode": "auto"})
    mgr.check()
    return mgr


def test_auto_waits_three_days_and_for_the_window(host):
    mgr = auto_host(host, 2.9)
    assert mgr.auto_due() is None                       # 공개 후 3일 미경과
    host.clock += timedelta(hours=3)                    # 3일은 경과했으나 07:00 — 시간대 밖
    assert mgr.auto_due() is None
    host.clock += timedelta(hours=20)                   # 다음 날 03:00
    assert mgr.local_minutes() == 3 * 60 and mgr.auto_due() == "1.0.1"
    mgr.put_settings({"mode": "manual"})
    assert mgr.auto_due() is None
    mgr.put_settings({"mode": "auto", "window": {"start": "22:00", "end": "02:00"}})
    assert mgr.auto_due() is None
    host.clock += timedelta(hours=20)                   # 23:00 — 자정을 넘는 시간대 안
    assert mgr.auto_due() == "1.0.1"


def test_auto_update_opens_a_countdown_then_applies(host):
    mgr = auto_host(host, 4)
    with pytest.raises(Killed):
        mgr.tick()
    job = mgr.active()
    assert job["trigger"] == "auto" and job["actor"] is None
    assert host.event_types()[:2] == ["countdown", "maintenance"] and host.posts[0]["trigger"] == "auto"
    assert job["maintenance_started_at"] == rel.utc_iso(host.clock.replace(hour=19, minute=5, second=0))
    mgr, job_id = run_to_end(host, mgr, lambda m: m.active())
    last = mgr.status()["last_auto"]
    assert last["job"] == job_id and last["result"] == "success" and last["version"] == "1.0.1"
    assert host.posts[-1]["trigger"] == "auto" and mgr.history()["items"][0]["actor"] is None


def test_auto_failure_rolls_back_at_any_step_and_pauses_until_resumed(host):
    mgr = auto_host(host, 4)
    host.fail_pull = {"just-workspace-backend@"}
    mgr.tick()
    job = mgr.job_raw(mgr.history_raw()[0]["id"])
    assert job["status"] == "failed" and job["choices"] == [] and job["rollback_job"]      # migrate 이전이어도 자동 롤백
    st = mgr.status()
    assert st["auto"]["paused"] is True and st["auto"]["reason"] == {"job": job["id"], "step": "pull", "version": "1.0.1"}
    assert st["last_auto"]["result"] == "rolled_back" and st["last_auto"]["failed_step"] == "pull"
    assert host.posts[-1]["trigger"] == "auto" and host.posts[-1]["result"] == "rolled_back"
    host.fail_pull = set()
    mgr.tick()
    assert mgr.active() is None and len(mgr.history_raw()) == 1       # 일시 중지 상태에서는 재시도하지 않는다
    assert mgr.auto_resume()["auto"]["paused"] is False
    assert mgr.auto_due() == "1.0.1"


def test_cancelling_auto_countdown_skips_this_window_without_pausing(host):
    mgr = auto_host(host, 4)
    spawn, mgr._spawn = mgr._spawn, lambda job_id: None
    mgr.tick()
    mgr._spawn = spawn
    mgr.action(mgr.active()["id"], "cancel", None)
    assert mgr.status()["auto"]["paused"] is False and mgr.auto_due() is None
    host.clock += timedelta(hours=24)
    assert mgr.auto_due() == "1.0.1"


def test_tick_checks_every_six_hours(host):
    mgr = ready(host, "1.0.0")
    count = len(host.releases.fetched)
    mgr.tick()
    assert len(host.releases.fetched) == count          # 아직 시점 미도래
    host.clock += timedelta(hours=6, minutes=31)
    mgr.tick()
    assert len(host.releases.fetched) > count


# ─── 채널 · 복원 지점 ───


def test_settings_validation_and_contact(host):
    mgr = ready(host, "1.0.0")
    with pytest.raises(UpdateError) as e:
        mgr.put_settings({"mode": "weekly", "window": {"start": "03:30", "end": "05:00"}, "channel": "nightly"})
    assert e.value.code == "settings_invalid"
    assert {x["field"] for x in e.value.vars["errors"]} == {"mode", "window", "channel"}
    with pytest.raises(UpdateError):
        mgr.put_settings({"window": {"start": "03:00", "end": "03:00"}})
    out, started = mgr.put_settings({"window": {"start": "01:00", "end": "04:00"}})
    assert started is False and out["effect"] == {"channel": None, "wait": None, "job": None}
    assert out["settings"]["window"] == {"start": "01:00", "end": "04:00"} and out["settings"]["min_age_days"] == 3
    assert mgr.set_contact("  내선 1234 ") == {"contact": "내선 1234"} and mgr.maintenance()["contact"] == "내선 1234"
    with pytest.raises(UpdateError):
        mgr.set_contact("a\nb")
    assert mgr.set_contact(None) == {"contact": None}


def test_beta_then_back_to_stable_waits_or_restores(host):
    mgr = ready(host, "1.0.0")
    host.releases.publish("1.1.0-beta.1", channels=("beta",), db_schema=2)
    assert mgr.status()["available"] == {"state": "none"}
    out, _ = mgr.put_settings({"channel": "beta"})
    assert out["effect"]["channel"] == "to_beta" and out["settings"]["beta"]["since"] == mgr.iso()
    assert mgr.status()["available"]["version"] == "1.1.0-beta.1" and mgr.status()["available"]["channel"] == "beta"
    mgr, job_id = run_to_end(host, mgr, lambda m: m.apply("1.1.0-beta.1", "now", None))
    assert mgr.current()["version"] == "1.1.0-beta.1" and mgr.status()["current"]["channel"] == "beta"
    beta_point = mgr.settings()["beta"]["restore_point"]
    assert beta_point["kind"] == "pre-beta" and beta_point["version"] == "1.0.0"
    # 일반 복원 지점이 순환 제거되어도 시험판 이전 백업은 보존된다
    for n in range(2, 2 + KEEP_POINTS + 1):
        host.releases.publish(f"1.1.0-beta.{n}", channels=("beta",), db_schema=2)
        mgr.check()
        mgr, _ = run_to_end(host, mgr, lambda m, n=n: m.apply(f"1.1.0-beta.{n}", "now", None))
    kinds = [p["kind"] for p in mgr.restore_points()["points"]]
    assert kinds == ["pre-update"] * KEEP_POINTS + ["pre-beta"]
    assert len(host.runner.find("exec", "ws-backend", "rm", "-rf")) == 1          # 순환 제거된 백업은 삭제한다

    out, started = mgr.put_settings({"channel": "stable", "stable_return": "wait"})
    assert started is False and out["effect"]["channel"] == "to_stable_wait"
    assert out["effect"]["wait"] == {"channel_latest": "1.0.0", "resume_from": "1.1.0"}
    assert mgr.status()["available"]["state"] == "wait" and mgr.settings()["beta"]["restore_point"] is not None

    mgr.put_settings({"channel": "beta"})
    with pytest.raises(Killed):
        mgr.put_settings({"channel": "stable", "stable_return": "restore", "start": "now"})
    job = mgr.active()
    assert job["kind"] == "restore" and job["restore"] == {"point": beta_point["id"], "version": "1.0.0", "reason": "beta"}
    mgr, _ = run_to_end(host, mgr, lambda m: m.active())
    assert mgr.current()["version"] == "1.0.0" and mgr.own_version == "1.0.0" and host.schema == 1
    assert mgr.settings()["channel"] == "stable" and mgr.settings()["beta"] == {"since": None, "restore_point": None}
    assert mgr.history()["items"][0]["result"] == "restored" and mgr.history()["items"][0]["kind"] == "restore"
    assert "pre-beta" not in [p["kind"] for p in mgr.restore_points()["points"]]


def test_stable_return_restore_without_backup(host):
    mgr = ready(host, "1.0.0")
    mgr.put_settings({"channel": "beta"})
    with pytest.raises(UpdateError) as e:
        mgr.put_settings({"channel": "stable", "stable_return": "restore"})
    assert e.value.code == "restore_point_missing" and mgr.settings()["channel"] == "beta"


def test_pre_beta_backup_is_dropped_once_stable_catches_up(host):
    mgr = ready(host, "1.0.0")
    host.releases.publish("1.1.0-beta.1", channels=("beta",))
    mgr.put_settings({"channel": "beta"})
    mgr, _ = run_to_end(host, mgr, lambda m: m.apply("1.1.0-beta.1", "now", None))
    mgr.put_settings({"channel": "stable"})
    host.releases.publish("1.1.0")
    mgr.check()
    assert mgr.status()["available"]["version"] == "1.1.0"        # Stable 이 현재 버전 이상이 되었다
    mgr, _ = run_to_end(host, mgr, lambda m: m.apply("1.1.0", "now", None))
    assert mgr.settings()["beta"] == {"since": None, "restore_point": None}
    assert [p["kind"] for p in mgr.restore_points()["points"]] == ["pre-update"]


def test_manual_restore_to_a_restore_point(host):
    mgr = ready(host, "1.0.0", "1.0.1", db_schema=2)
    mgr, _ = run_to_end(host, mgr, lambda m: m.apply("1.0.1", "now", None))
    point = mgr.restore_points()["points"][0]
    with pytest.raises(UpdateError) as e:
        mgr.start_restore("rp-nope", "now", None)
    assert e.value.code == "restore_point_unknown" and e.value.status == 404
    mgr, job_id = run_to_end(host, mgr, lambda m: m.start_restore(point["id"], "now", {"id": "u1", "name": "관리자"}))
    job = mgr.job_raw(job_id)
    assert job["kind"] == "restore" and job["status"] == "done" and job["restore"]["reason"] == "manual"
    assert [s["id"] for s in job["steps"]] == ["stop", "images", "restore_db", "start", "verify"]
    assert mgr.current()["version"] == "1.0.0" and host.schema == 1 and host.env_version() == "1.0.0"
    row = mgr.history()["items"][0]
    assert row["kind"] == "restore" and row["result"] == "restored" and row["from_version"] == "1.0.1"
    assert host.posts[-1]["result"] == "restored" and host.posts[-1]["kind"] == "restore"
    mgr.check()
    assert mgr.status()["available"]["version"] == "1.0.1"        # 재업데이트 가능


def test_restore_failure_offers_only_retry(host):
    mgr = ready(host, "1.0.0", "1.0.1", db_schema=2)
    mgr, _ = run_to_end(host, mgr, lambda m: m.apply("1.0.1", "now", None))
    host.fail_restore = True
    job = mgr.start_restore(mgr.restore_points()["points"][0]["id"], "now", None)
    assert job["status"] == "failed" and job["choices"] == ["retry"] and job["error"]["step"] == "restore_db"
    assert mgr.history()["items"][0]["result"] == "restore_failed"


def test_restore_point_with_wrong_schema_is_refused(host):
    mgr = ready(host, "1.0.0", "1.0.1", db_schema=2)
    mgr, _ = run_to_end(host, mgr, lambda m: m.apply("1.0.1", "now", None))
    host.backup_schema[host.backups[0]] = 7             # 백업 파일이 기록과 불일치한다
    job = mgr.start_restore(mgr.restore_points()["points"][0]["id"], "now", None)
    assert job["error"]["cause"] == "restore_point_schema_mismatch"
    assert host.runner.find("compose", "run", "backend", "restore") == []


def test_old_images_are_removed_with_their_restore_point(host):
    mgr = ready(host, "1.0.0")
    for n in range(1, KEEP_POINTS + 2):
        host.releases.publish(f"1.0.{n}")
        mgr.check()
        mgr, _ = run_to_end(host, mgr, lambda m, n=n: m.apply(f"1.0.{n}", "now", None))
    versions = [p["version"] for p in mgr.restore_points()["points"]]
    assert versions == ["1.0.3", "1.0.2", "1.0.1"]
    assert "localhost/just-workspace-backend:1.0.0" not in host.images       # 가리키는 복원 지점이 없는 버전
    assert "localhost/just-workspace-backend:1.0.1" in host.images
    assert not (mgr.dir / "snapshots").joinpath("x").exists() and len(list((mgr.dir / "snapshots").iterdir())) == KEEP_POINTS


# ─── 기록 ───


def test_history_keeps_one_year_and_downtime_feeds_the_estimate(host):
    mgr = ready(host, "1.0.0", "1.0.1")
    mgr, job_id = run_to_end(host, mgr, lambda m: m.apply("1.0.1", "now", None))
    row = mgr.history()["items"][0]
    assert row["downtime_seconds"] == row["duration_seconds"] is not None
    items = mgr.history_raw()
    items[0]["downtime_seconds"] = 150
    mgr._write("history.json", items)
    assert mgr.estimate_downtime(2) == 300              # 직전 업데이트의 실측값 × 버전 수
    assert mgr.read_log(job_id) and mgr.read_log(job_id, 2) == mgr.read_log(job_id)[-2:]
    host.clock += timedelta(days=364)
    mgr.prune_history()
    assert len(mgr.history_raw()) == 1
    host.clock += timedelta(days=2)
    mgr.prune_history()
    assert mgr.history_raw() == [] and mgr.job_raw(job_id) is None and mgr.read_log(job_id) == []
    with pytest.raises(UpdateError) as e:
        mgr.history_entry(job_id)
    assert e.value.code == "history_unknown"


def test_log_hides_secrets(host):
    from tests.conftest import SECRETS

    mgr = ready(host, "1.0.0", "1.0.1")
    host.runner.on("exec", "ws-backend", "backup", "create", rc=1, err=f"DB_PASSWORD={SECRETS['DB_PASSWORD']} 로 접속 실패")
    job = mgr.apply("1.0.1", "now", None)
    assert job["error"]["cause"] == "backup_failed"
    text = "\n".join(mgr.read_log(job["id"]))
    assert SECRETS["DB_PASSWORD"] not in text and "***" in text


# ─── 자기 교체 계획 ───


def test_swap_plan_carries_name_ports_volumes_env_and_networks():
    container = {
        "Id": "0123456789abcdef", "Name": "/jw-installer",
        "Config": {"Hostname": "0123456789ab", "Env": ["JW_HOST_DIR=/opt/just-workspace", "JW_REGISTRY=registry.example.com/jw",
                                                       "JW_IMAGE_TAG=1.0.0", "PATH=/usr/bin", "JW_DATA_DIR=/data"]},
        "HostConfig": {"RestartPolicy": {"Name": "unless-stopped"}, "Binds": ["/var/run/docker.sock:/var/run/docker.sock",
                                                                            "/opt/just-workspace:/data"],
                       "PortBindings": {"8443/tcp": [{"HostIp": "", "HostPort": "8443"}]}},
        "NetworkSettings": {"Networks": {"bridge": {"Aliases": None},
                                         "just-workspace_workspace": {"Aliases": ["jw-installer", "0123456789ab"]}}},
    }
    image = {"Config": {"Env": ["PATH=/usr/bin", "JW_DATA_DIR=/data", "JW_REGISTRY=ghcr.io/just-workspace"]}}
    argv, networks = update_swap.plan_create(container, image, "localhost/just-workspace-installer:1.0.1", "1.0.1")
    assert argv[:3] == ["create", "--name", "jw-installer"] and argv[-1] == "localhost/just-workspace-installer:1.0.1"
    assert argv[argv.index("--restart") + 1] == "unless-stopped" and argv[argv.index("-p") + 1] == "8443:8443/tcp"
    assert [argv[i + 1] for i, a in enumerate(argv) if a == "-v"] == container["HostConfig"]["Binds"]
    envs = [argv[i + 1] for i, a in enumerate(argv) if a == "-e"]
    # 이미지 기본값·이전 태그는 제외하고 제품 버전을 포함한다(승격한 릴리스의 이미지에는 Beta 문자열이 포함되어 있다)
    assert envs == ["JW_HOST_DIR=/opt/just-workspace", "JW_REGISTRY=registry.example.com/jw", "JW_INSTALLER_VERSION=1.0.1"]
    assert argv[argv.index("--network") + 1] == "bridge"
    assert networks == [("just-workspace_workspace", ["jw-installer"])]
    # 롤백 시에는 복원 지점에 기록해 둔 환경을 그대로 사용한다(현재 컨테이너의 환경에서 추출하지 않는다)
    argv, _ = update_swap.plan_create(container, image, "sha256:old", "1.0.0", env=["JW_HOST_DIR=/opt/just-workspace", "JW_IMAGE_TAG=x"])
    assert [argv[i + 1] for i, a in enumerate(argv) if a == "-e"] == ["JW_HOST_DIR=/opt/just-workspace", "JW_INSTALLER_VERSION=1.0.0"]


def test_compose_does_not_see_the_installers_own_version_env(monkeypatch):
    import sys

    from app.docker_api import SubprocessRunner

    monkeypatch.setenv("JW_APP_VERSION", "9.9.9")
    monkeypatch.setenv("JW_VERSION", "9.9.9")
    monkeypatch.setenv("JW_HOST_DIR", "/opt/just-workspace")
    r = SubprocessRunner(binary=sys.executable).run(
        ["-c", "import os;print(os.environ.get('JW_APP_VERSION'), os.environ.get('JW_VERSION'), os.environ.get('JW_HOST_DIR'))"])
    assert r.out.strip() == "None None /opt/just-workspace"
