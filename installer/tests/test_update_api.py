"""업데이트 내부 API — 응답이 계약 문서(docs/update-api.md)의 예시와 같은 모양인지, 오프라인 준비물, 접근 제어."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from app import api, api_update
from app.update_engine import UpdateError
from app.update_offline import clean_filename
from tests.update_harness import THIRD, Killed, UpdateHost, internal_client, run_to_end

DOC = Path(__file__).resolve().parents[2] / "docs" / "update-api.md"


@pytest.fixture(scope="module")
def examples() -> list[dict]:
    """계약 문서의 JSON 예시(객체인 것)."""
    out = []
    for block in re.findall(r"```json\n(.*?)```", DOC.read_text(encoding="utf-8"), re.S):
        for text in (block, *block.strip().splitlines()):
            try:
                data = json.loads(text)
            except ValueError:
                continue
            if isinstance(data, dict):
                out.append(data)
                break
    return out


def example(examples: list[dict], *keys: str, without: tuple[str, ...] = ()) -> dict:
    found = [e for e in examples if all(k in e for k in keys) and not any(k in e for k in without)]
    assert found, f"계약 문서에 {keys} 가 든 예시가 없다"
    return found[0]


@pytest.fixture()
def host(tmp_path, monkeypatch) -> UpdateHost:
    host = UpdateHost(tmp_path, monkeypatch)
    host.install_keys()
    return host


def same_keys(actual: dict, expected: dict, *, ignore: tuple[str, ...] = ()) -> None:
    assert set(actual) - set(ignore) == set(expected) - set(ignore) - {"…"}


# ─── 계약의 모양 ───


def test_status_settings_and_job_match_the_contract(host, examples):
    host.releases.publish("1.0.0")
    host.releases.publish("1.0.1")
    mgr = host.manager()
    client = internal_client(host)
    r = client.post("/internal/update/check")
    assert r.status_code == 202
    st = client.get("/internal/update/status").json()
    doc = example(examples, "current", "available")
    same_keys(st, doc)
    for part in ("current", "settings", "check", "auto"):
        same_keys(st[part], doc[part])
    same_keys(st["available"], example(examples, "auto_eligible_at"))
    assert st["check"] == {"state": "idle", "last_at": mgr.iso(), "ok": True, "error": None}

    same_keys(client.get("/internal/update/settings").json(), example(examples, "min_age_days", "beta", without=("effect",)))
    reply = client.put("/internal/update/settings", json={"mode": "auto", "actor": {"id": "u", "name": "n"}})
    doc = example(examples, "effect")
    assert reply.status_code == 200
    same_keys(reply.json(), doc)
    same_keys(reply.json()["effect"], doc["effect"])
    same_keys(reply.json()["settings"], doc["settings"])
    assert client.put("/internal/update/settings", json={"mode": "x"}).json()["code"] == "settings_invalid"

    host.fail_pull = {"just-workspace-backend@"}
    r = client.post("/internal/update/apply", json={"target": "1.0.1", "start": "now", "actor": {"id": "u1", "name": "관리자"}})
    assert r.status_code == 202
    job = client.get(f"/internal/update/jobs/{r.json()['id']}").json()
    doc = example(examples, "steps", "choices")
    same_keys(job, doc)
    assert "ctx" not in job and job["actor"] == {"id": "u1", "name": "관리자"}
    assert [s["id"] for s in job["steps"]] == [s["id"] for s in doc["steps"]]
    same_keys(job["steps"][0], doc["steps"][0])
    same_keys(job["steps"][-1], doc["steps"][-1])
    assert set(job["steps"][2]["detail"]["images"][0]) == set(doc["steps"][2]["detail"]["images"][0])
    assert set(job["error"]) == {"step", "cause", "detail", "vars"}
    assert client.get("/internal/update/status").json()["job"]["id"] == job["id"]
    assert client.post("/internal/update/check").json() == {"code": "busy", "vars": {"job": job["id"]}}

    log = client.get(f"/internal/update/jobs/{job['id']}/log", params={"tail": 3}).json()
    assert len(log["lines"]) == 3 and all("[pull]" in line for line in log["lines"])
    text = client.get(f"/internal/update/jobs/{job['id']}/log", params={"format": "text"})
    assert text.headers["content-type"].startswith("text/plain") and "[preflight] 시작" in text.text

    r = client.post(f"/internal/update/jobs/{job['id']}/action", json={"action": "start_now"})
    assert r.status_code == 409 and r.json() == {"code": "action_not_allowed",
                                                 "vars": {"status": "failed", "allowed": ["retry", "rollback"]}}
    r = client.post(f"/internal/update/jobs/{job['id']}/action", json={"action": "rollback", "actor": None})
    assert r.status_code == 200 and r.json()["id"] == job["id"] and r.json()["rollback_job"]
    rollback = client.get(f"/internal/update/jobs/{r.json()['rollback_job']}").json()
    same_keys(rollback, doc, ignore=("parent_job",))
    assert rollback["parent_job"] == job["id"]

    history = client.get("/internal/update/history").json()
    doc = example(examples, "items", "retention_days")
    same_keys(history, doc)
    same_keys(history["items"][0], doc["items"][0])
    entry = client.get(f"/internal/update/history/{job['id']}").json()
    doc = example(examples, "versions", "rollback")
    assert {"versions", "rollback"} <= set(entry)
    same_keys(entry["versions"][0]["steps"][0], doc["versions"][0]["steps"][0])
    same_keys(entry["rollback"], doc["rollback"])
    assert client.get("/internal/update/history/nope").json()["code"] == "history_unknown"
    assert client.get("/internal/update/jobs/nope").status_code == 404
    assert client.post("/internal/update/auto/resume").json()["auto"]["paused"] is False


def test_restore_points_apps_releases_and_maintenance_match_the_contract(host, examples):
    host.releases.publish("1.0.0")
    host.releases.publish("1.0.1")
    mgr = host.manager()
    mgr.check()
    mgr, _ = run_to_end(host, mgr, lambda m: m.apply("1.0.1", "now", None))
    client = internal_client(host)
    points = client.get("/internal/update/restore-points").json()
    same_keys(points["points"][0], example(examples, "points")["points"][0])
    apps = client.get("/internal/update/apps").json()
    same_keys(apps, example(examples, "download_page"))
    assert apps == {"version": "1.0.1", "download_page": None, "apps": []}
    notes = client.get("/internal/update/releases/1.0.1").json()
    same_keys(notes, example(examples, "disabled_plugins"))
    assert client.get("/internal/update/releases/9.9.9").json()["code"] == "history_unknown"
    assert client.get("/internal/update/releases/not-a-version").status_code == 404

    r = client.post("/internal/update/restore", json={"point": "rp-nope"})
    assert r.status_code == 404 and r.json()["code"] == "restore_point_unknown"
    spawn, mgr._spawn = mgr._spawn, lambda job_id: None
    r = client.post("/internal/update/restore", json={"point": points["points"][0]["id"]})
    assert r.status_code == 202 and r.json()["kind"] == "restore" and r.json()["status"] == "countdown"

    live = client.get("/internal/update/maintenance")
    doc = example(examples, "phase", "countdown_ends_at")
    same_keys(live.json(), doc)                       # 버전·단계·오류·사용자 이름이 실릴 자리가 없다
    assert live.headers["cache-control"] == "no-store" and live.json()["phase"] == "countdown"
    assert client.put("/internal/update/maintenance/contact", json={"contact": "내선 1234"}).json() == {"contact": "내선 1234"}
    assert client.put("/internal/update/maintenance/contact", json={"contact": "x" * 201}).status_code == 422
    mgr._spawn = spawn


def test_only_the_maintenance_status_opens_without_the_key(host):
    from starlette.testclient import TestClient

    host.manager()
    app = api.create_internal_app(host.svc)
    inside = TestClient(app, client=("172.28.0.2", 5000))          # nginx
    outside = TestClient(app, client=("192.168.10.77", 5000))
    assert inside.get("/internal/update/maintenance").json()["active"] is False
    assert outside.get("/internal/update/maintenance").status_code == 404
    for method, path in (("get", "/status"), ("post", "/check"), ("get", "/settings"), ("post", "/apply"),
                         ("get", "/history"), ("get", "/offline"), ("get", "/restore-points"), ("get", "/apps"),
                         ("put", "/maintenance/contact"), ("post", "/auto/resume"), ("delete", "/offline/bundle")):
        r = getattr(inside, method)(f"/internal/update{path}")
        assert r.status_code == 404 and r.json() == {"code": "not_found", "vars": {}}, path


def test_not_installed(host):
    host.manager()
    host.svc.store.set_phase("applying")
    client = internal_client(host)
    assert client.post("/internal/update/check").json()["code"] == "not_installed"
    assert client.post("/internal/update/apply", json={"target": "1.0.1"}).status_code == 409


# ─── 오프라인 ───


def tag_of(mgr, name: str) -> str:
    refs = {n: r for m in THIRD.values() for n, r in m.items()}
    return mgr.third_party_tag(refs[name])


def test_offline_bundle_by_path_extra_images_and_apply(host, examples):
    bundle = host.releases.bundle(host.paths.data, "1.0.1", db_schema=2)
    mgr = host.manager()
    client = internal_client(host)
    doc = example(examples, "bundle", "images", "blockers")
    empty = client.get("/internal/update/offline").json()
    same_keys(empty, doc)
    assert empty["bundle"] is None and empty["blockers"] == ["bundle_missing"] and empty["accept"] == ".tar"

    # 호스트의 설치 폴더 기준 경로로 적어도 받는다
    r = client.post("/internal/update/offline/bundle-path", json={"path": f"/opt/just-workspace/{bundle.name}"})
    assert r.status_code == 202
    view = r.json()
    same_keys(view["bundle"], doc["bundle"])
    assert view["bundle"]["state"] == "verified" and view["bundle"]["version"] == "1.0.1"
    assert view["bundle"]["current_version"] == "1.0.0" and view["bundle"]["source"] == "path"
    rows = {i["id"]: i for i in view["images"]}
    same_keys(rows["postgres"], doc["images"][0])
    assert rows["postgres"]["reason"] == "always" and rows["postgres"]["zone"] is None and rows["postgres"]["state"] == "missing"
    assert rows["onlyoffice"]["reason"] == "zone" and rows["onlyoffice"]["zone"]["id"] == "docs"
    assert rows["gitea"]["state"] == "not_needed" and rows["gitea"]["zone_enabled"] is False     # 꺼진 구역의 것
    ref = THIRD["core"]["postgres"]
    assert rows["postgres"]["command"] == (f"docker pull {ref} && docker tag {ref} {tag_of(mgr, 'postgres')} && "
                                           f"docker save {tag_of(mgr, 'postgres')} -o postgres.tar")
    assert view["ready"] is False and view["blockers"] == ["images_missing"]
    r = client.post("/internal/update/offline/apply", json={"start": "now"})
    assert r.status_code == 409 and r.json() == {"code": "offline_incomplete", "vars": {"blockers": ["images_missing"]}}

    # 이미지 파일 올리기 — 엉뚱한 파일은 불일치, 맞는 파일은 있음
    r = client.post("/internal/update/offline/images/postgres", content=b"tag something:else")
    assert r.status_code == 202
    view = client.get("/internal/update/offline").json()
    assert {i["id"]: i["state"] for i in view["images"]}["postgres"] == "hash_mismatch"
    assert "images_mismatch" in view["blockers"]
    assert client.post("/internal/update/offline/images/nope", content=b"x").json()["code"] == "image_unknown"
    for name in ("postgres", "redis", "onlyoffice"):
        client.post(f"/internal/update/offline/images/{name}", content=f"tag {tag_of(mgr, name)}".encode())
    host.images[THIRD["core"]["nginx"]] = "sha256:already"            # 다이제스트로 이미 있는 것
    view = client.get("/internal/update/offline").json()
    assert {i["id"]: i["state"] for i in view["images"]} == {"postgres": "present", "redis": "present", "nginx": "present",
                                                           "onlyoffice": "present", "gitea": "not_needed"}
    assert view["ready"] is True and view["blockers"] == []
    assert not list((mgr.dir / "offline").glob("image-*.tar"))        # 들여온 파일은 지운다

    with pytest.raises(Killed):
        api_update.offline(host.svc).apply("now", {"id": "u1", "name": "관리자"})
    job = mgr.active()
    assert job["trigger"] == "offline" and job["path"] == ["1.0.1"]
    assert host.runner.find("pull") == []                              # 받지 않는다 — 묶음에서 들인다
    assert len(host.runner.find("load", "-i")) >= 3 + len(("backend", "frontend-react", "mailserver", "installer"))
    assert "localhost/just-workspace-backend:1.0.1" in host.images
    pins = (host.paths.stack / "docker-compose.pins.yml").read_text(encoding="utf-8")
    assert f"  postgres:\n    image: {tag_of(mgr, 'postgres')}" in pins and "nginx" not in pins
    assert any("docker-compose.pins.yml" in a for a in host.runner.find("compose", "up", "backend")[0])
    mgr, job_id = run_to_end(host, mgr, lambda m: m.active())
    assert mgr.job_raw(job_id)["status"] == "done" and mgr.current()["version"] == "1.0.1" and host.schema == 2
    assert mgr.history()["items"][0]["trigger"] == "offline"
    assert internal_client(host).get("/internal/update/offline").json()["bundle"] is None     # 적용한 준비물은 치운다
    assert bundle.exists()                                             # 경로로 지정한 파일은 건드리지 않는다


def test_offline_upload_is_streamed_to_disk_and_verified(host):
    bundle = host.releases.bundle(host.paths.data.parent, "1.0.1")
    mgr = host.manager()
    client = internal_client(host)
    r = client.post("/internal/update/offline/bundle", content=bundle.read_bytes(),
                    headers={"X-JW-Filename": "just-workspace-1.0.1-offline%20(1).tar"})
    assert r.status_code == 202
    view = r.json()
    assert view["bundle"]["source"] == "upload" and view["bundle"]["filename"] == "just-workspace-1.0.1-offline (1).tar"
    assert view["bundle"]["state"] == "verified" and view["bundle"]["size_bytes"] == bundle.stat().st_size
    assert (mgr.dir / "offline" / "bundle.tar").stat().st_size == bundle.stat().st_size
    assert view["download_url"].endswith("/v1.0.1/just-workspace-1.0.1-offline.tar")
    assert client.delete("/internal/update/offline/bundle").json()["bundle"] is None
    assert not (mgr.dir / "offline" / "bundle.tar").exists()


@pytest.mark.parametrize("case, state, code", [
    ("other_key", "signature_mismatch", "signature"),
    ("low", "version_too_low", "version_too_low"),
    ("same", "version_too_low", "version_too_low"),
    ("tampered", "invalid", "invalid"),
    ("not_a_bundle", "invalid", "invalid"),
    ("no_path", "invalid", "no_upgrade_path"),
    ("missing", "file_missing", None),
    ("outside", "file_missing", None),
])
def test_offline_bundle_rejections(host, tmp_path, case, state, code):
    mgr = host.manager()
    off = api_update.offline(host.svc)
    data = host.paths.data
    if case == "other_key":
        path = host.releases.bundle(data, "1.0.1", key=ec.generate_private_key(ec.SECP256R1()))
    elif case == "low":
        mgr._write("current.json", {"version": "1.2.0", "applied_at": None, "previous_version": None})
        path = host.releases.bundle(data, "1.0.1")
    elif case == "same":
        path = host.releases.bundle(data, "1.0.0")
    elif case == "tampered":
        path = host.releases.bundle(data, "1.0.1")
        raw = bytearray(path.read_bytes())
        at = raw.index(b"image backend 1.0.1")
        raw[at:at + 5] = b"IMAGE"                       # 서명은 맞지만 파일 해시가 어긋난다
        path.write_bytes(bytes(raw))
    elif case == "not_a_bundle":
        path = data / "x.tar"
        path.write_bytes(b"hello")
    elif case == "no_path":
        path = host.releases.bundle(data, "1.1.0", min_upgrade_from="1.0.5")
    elif case == "missing":
        path = data / "nope.tar"
    else:
        path = tmp_path / "outside.tar"                 # 설치 관리자에게 보이는 폴더 밖
        path.write_bytes(b"x")
    off.use_path(str(path))
    view = off.view()
    assert view["bundle"]["state"] == state and view["images"] == [] and view["ready"] is False
    assert view["blockers"] == ["bundle_rejected"]
    if code:
        assert view["bundle"]["error"]["code"] == code
    with pytest.raises(UpdateError) as e:
        off.apply("now", None)
    assert e.value.code == "offline_incomplete"


def test_offline_without_public_key_and_limits(host, monkeypatch):
    from app import update_offline

    for key in (host.paths.state / "update" / "keys").iterdir():
        key.unlink()
    path = host.releases.bundle(host.paths.data, "1.0.1")
    host.manager()
    off = api_update.offline(host.svc)
    off.use_path(str(path))
    assert off.view()["bundle"]["state"] == "signature_mismatch" and off.view()["bundle"]["error"]["code"] == "unconfigured"
    monkeypatch.setattr(update_offline, "UPLOAD_MAX", 10)
    with pytest.raises(UpdateError) as e:
        off.receive(iter([b"x" * 20]), "a.tar", None)
    assert e.value.status == 413 and e.value.code == "too_large" and e.value.vars == {"limit": 10}
    assert not (off.dir / "bundle.tar").exists()
    monkeypatch.setattr(update_offline, "UPLOAD_MAX", 10 ** 12)
    monkeypatch.setattr(off, "_free", lambda: 100)
    with pytest.raises(UpdateError) as e:
        off.receive(iter([b"x"]), "a.tar", 1000)
    assert e.value.status == 507 and e.value.code == "no_space"


def test_offline_refused_while_a_job_is_active(host):
    host.releases.publish("1.0.1")
    mgr = host.manager()
    mgr.check()
    mgr._spawn = lambda job_id: None
    job = mgr.apply("1.0.1", "countdown", None)
    r = internal_client(host).post("/internal/update/offline/bundle-path", json={"path": "/data/x.tar"})
    assert r.status_code == 409 and r.json() == {"code": "busy", "vars": {"job": job["id"]}}


def test_filename_header():
    assert clean_filename("a%20b.tar", "x") == "a b.tar"
    assert clean_filename("..%2F..%2Fetc%2Fpasswd", "x") == "passwd"
    assert clean_filename(None, "bundle.tar") == "bundle.tar" and clean_filename("%00", "x") == "x"
