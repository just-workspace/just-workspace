"""원격 데스크톱 플러그인 — 기기 등록·권한·동의·1회성 코드(발급·만료·1회성·레이트리밋)·토큰 권한 범위·감사.

코어 backend 이미지 내부에서 실행한다(app.* 를 import 할 수 있는 환경):
  docker run --rm -v <이 플러그인>:/plug:ro -e PYTHONPATH=/app --entrypoint sh <backend 이미지>     -c 'cd /tmp && python -m pytest -q -p no:cacheprovider -o asyncio_mode=auto /plug/backend/tests'

DB 는 임시 SQLite 파일. LiveKit 서버는 호출하지 않는다(방 생성·종료는 가짜로 대체). 토큰은 JWT 본문만 디코드해 권한을 확인한다.
"""
from __future__ import annotations

import base64
import importlib.util
import json
import os
import sys
import tempfile
from datetime import timedelta
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="remote-test-")
os.environ.update({
    "DATABASE_URL": f"sqlite+aiosqlite:///{_TMP}/app.db",
    "SECRET_KEY": "test-secret-key-not-for-production",
    "DEBUG": "true",
    "APP_URL": "http://localhost:8000",
    "DOMAIN": "localhost",
    "REDIS_URL": "redis://127.0.0.1:1/0",
    "RATE_LIMIT_STORAGE_URI": "memory://",
    "STORAGE_ROOT": _TMP,
})

import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402
from slowapi.errors import RateLimitExceeded  # noqa: E402

BACKEND = Path(__file__).resolve().parents[1]


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, BACKEND / file)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


models = _load("plugin_remote-desktop_models", "models.py")
rr = _load("plugin_remote-desktop_router", "router.py")
svc = sys.modules["plugin_remote-desktop_service"]
RemoteAudit, RemoteDevice, RemoteSession = models.RemoteAudit, models.RemoteDevice, models.RemoteSession

from app.auth.deps import get_current_user  # noqa: E402
from app.db.models import User  # noqa: E402
from app.db.session import async_session, engine  # noqa: E402
from app.rate_limit import limiter  # noqa: E402

B = "/api/plugins/remote-desktop"

ADMIN = User(id="u-admin", username="admin", display_name="관리자", is_admin=True, is_active=True, email="a@x", token_version=0)
ALICE = User(id="u-alice", username="alice", display_name="앨리스", is_admin=False, is_active=True, email="al@x", token_version=0)
BOB = User(id="u-bob", username="bob", display_name="밥", is_admin=False, is_active=True, email="b@x", token_version=0)

_ip_counter = [0]


def _ip() -> str:
    _ip_counter[0] += 1
    return f"10.9.{_ip_counter[0] // 250}.{_ip_counter[0] % 250 + 1}"


_current: dict = {"user": None}


def _app():
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, lambda r, e: JSONResponse({"detail": "rate"}, status_code=429))
    app.include_router(rr.router, prefix=B)

    def _user():
        if _current["user"] is None:
            from fastapi import HTTPException
            raise HTTPException(401)
        return _current["user"]
    app.dependency_overrides[get_current_user] = _user
    return app


_APP = _app()


async def _req(user, db, method, url, ip=None, **kw):  # noqa: ARG001 — db 는 이전 호출 형태 유지용
    _current["user"] = user
    t = ASGITransport(app=_APP, client=(ip or _ip(), 1234))
    async with AsyncClient(transport=t, base_url="http://t") as c:
        return await c.request(method, B + url.replace("/api/remote", ""), **kw)


async def _fresh(db, model, key):
    db.expire_all()
    return await db.get(model, key)


@pytest.fixture()
async def db_session():
    from app.db.models import Base as CoreBase  # 플러그인이 조회하는 코어 테이블(users·system_settings)
    async with engine.begin() as conn:
        await conn.run_sync(CoreBase.metadata.create_all)
    await rr._ensure_tables()
    async with async_session() as s:
        yield s
    async with engine.begin() as conn:
        for t in reversed(models.PluginBase.metadata.sorted_tables):
            await conn.execute(t.delete())


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    from app.modules import registry
    monkeypatch.setitem(registry._module_states, "remote-desktop", True)
    monkeypatch.setattr(svc.settings, "livekit_api_key", "lk-key")
    monkeypatch.setattr(svc.settings, "livekit_api_secret", "lk-secret-0123456789-0123456789-abc")
    monkeypatch.setattr(rr.lk, "is_configured", lambda: True)
    rooms = {"created": [], "deleted": []}

    async def _create(name, empty_timeout=300, max_participants=10):
        rooms["created"].append(name)
        return {}

    async def _delete(name):
        rooms["deleted"].append(name)
    monkeypatch.setattr(rr.lk, "create_room", _create)
    monkeypatch.setattr(rr.lk, "delete_room", _delete)
    return rooms


def _claims(tok: str) -> dict:
    p = tok.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))


async def _register(db, user=ALICE, allow=True, unattended=False):
    r = await _req(user, db, "POST", "/api/remote/devices", json={"name": "내 PC", "platform": "win32"})
    assert r.status_code == 201, r.text
    dev = r.json()["device"]
    secret = r.json()["host_secret"]
    hdr = {"X-Remote-Host": f"{dev['id']}:{secret}"}
    if allow or unattended:
        r = await _req(user, db, "PATCH", f"/api/remote/devices/{dev['id']}", json={"allow_remote": allow, "unattended": unattended})
        assert r.status_code == 200
    r = await _req(None, db, "GET", "/api/remote/host/poll", headers=hdr)  # 온라인 표시
    assert r.status_code == 200
    return dev, hdr


# ── 기기 ──

async def test_register_and_host_auth(db_session):
    dev, hdr = await _register(db_session)
    row = await _fresh(db_session, RemoteDevice, dev["id"])
    assert row.host_secret_hash != hdr["X-Remote-Host"].split(":")[1]  # 원문 미저장
    r = await _req(None, db_session, "GET", "/api/remote/host/poll", headers={"X-Remote-Host": f"{dev['id']}:wrong"})
    assert r.status_code == 401
    r = await _req(None, db_session, "GET", "/api/remote/host/poll")
    assert r.status_code == 401
    r = await _req(ALICE, db_session, "GET", "/api/remote/devices")
    assert [d["id"] for d in r.json()["devices"]] == [dev["id"]] and r.json()["devices"][0]["online"]


async def test_reregister_rotates_secret(db_session):
    dev, hdr = await _register(db_session)
    r = await _req(ALICE, db_session, "POST", "/api/remote/devices", json={"name": "내 PC", "platform": "win32"})
    assert r.json()["device"]["id"] == dev["id"]
    r = await _req(None, db_session, "GET", "/api/remote/host/poll", headers=hdr)
    assert r.status_code == 401  # 이전 비밀은 무효


async def test_connect_permissions(db_session):
    dev, _ = await _register(db_session)
    r = await _req(BOB, db_session, "POST", f"/api/remote/devices/{dev['id']}/connect")
    assert r.status_code == 404  # 타 사용자 기기는 존재 여부도 노출되지 않음
    r = await _req(ADMIN, db_session, "POST", f"/api/remote/devices/{dev['id']}/connect")
    assert r.status_code == 201  # 관리자는 요청 가능(동의는 호스트가 수행)
    r = await _req(ALICE, db_session, "POST", f"/api/remote/devices/{dev['id']}/connect")
    assert r.status_code == 409  # 이미 진행 중


async def test_connect_requires_allow_and_online(db_session):
    dev, hdr = await _register(db_session, allow=False)
    r = await _req(ALICE, db_session, "POST", f"/api/remote/devices/{dev['id']}/connect")
    assert r.status_code == 409 and "허용" in r.json()["detail"]
    await _req(ALICE, db_session, "PATCH", f"/api/remote/devices/{dev['id']}", json={"allow_remote": True})
    row = await _fresh(db_session, RemoteDevice, dev["id"])
    row.last_seen_at = svc.now() - timedelta(minutes=5)
    await db_session.commit()
    r = await _req(ALICE, db_session, "POST", f"/api/remote/devices/{dev['id']}/connect")
    assert r.status_code == 409 and "오프라인" in r.json()["detail"]


async def test_device_flow_tokens_and_end(db_session, _env):
    dev, hdr = await _register(db_session)
    r = await _req(ALICE, db_session, "POST", f"/api/remote/devices/{dev['id']}/connect")
    sid = r.json()["session"]["id"]
    # 동의 전에는 뷰어 토큰 없음
    r = await _req(ALICE, db_session, "GET", f"/api/remote/sessions/{sid}?token=1")
    assert r.json()["session"]["status"] == "pending" and "livekit" not in r.json()
    r = await _req(None, db_session, "GET", "/api/remote/host/poll", headers=hdr)
    s = r.json()["sessions"][0]
    assert s["id"] == sid and s["status"] == "pending" and s["requester_name"] == "앨리스" and s["auto_allow"] is False
    r = await _req(None, db_session, "POST", f"/api/remote/host/sessions/{sid}/decision", headers=hdr, json={"allow": True})
    assert r.status_code == 200
    host = r.json()["livekit"]
    hc = _claims(host["token"])["video"]
    assert hc["canPublish"] is True and hc["canPublishSources"] == ["screen_share"] and hc["canPublishData"] is True
    assert hc.get("roomAdmin") in (None, False) and hc.get("roomCreate") in (None, False)
    assert host["peer_identity"] == svc.viewer_identity(sid)
    room = host["room"]
    assert room.startswith("rd-") and room in _env["created"]
    r = await _req(ALICE, db_session, "GET", f"/api/remote/sessions/{sid}?token=1")
    v = r.json()["livekit"]
    vc = _claims(v["token"])["video"]
    assert vc.get("canPublish") in (None, False) and vc["canSubscribe"] is True and vc["canPublishData"] is True
    assert vc["room"] == room and _claims(v["token"])["sub"] == svc.viewer_identity(sid)
    # 관리자도 타 사용자의 세션 화면에는 접근 불가(요청자만 가능)
    r = await _req(ADMIN, db_session, "GET", f"/api/remote/sessions/{sid}?token=1")
    assert r.status_code == 403
    r = await _req(ALICE, db_session, "POST", f"/api/remote/sessions/{sid}/end")
    assert r.json()["session"]["status"] == "ended" and room in _env["deleted"]
    r = await _req(ALICE, db_session, "GET", f"/api/remote/sessions/{sid}?token=1")
    assert "livekit" not in r.json()  # 종료 후 토큰 재발급 없음
    r = await _req(None, db_session, "POST", f"/api/remote/host/sessions/{sid}/decision", headers=hdr, json={"allow": True})
    assert r.status_code == 409


async def test_consent_timeout_and_deny(db_session):
    dev, hdr = await _register(db_session)
    r = await _req(ALICE, db_session, "POST", f"/api/remote/devices/{dev['id']}/connect")
    sid = r.json()["session"]["id"]
    s = await _fresh(db_session, RemoteSession, sid)
    s.expires_at = svc.now() - timedelta(seconds=1)
    await db_session.commit()
    r = await _req(None, db_session, "POST", f"/api/remote/host/sessions/{sid}/decision", headers=hdr, json={"allow": True})
    assert r.status_code == 409
    assert (await _fresh(db_session, RemoteSession, sid)).status == "expired"
    r = await _req(ALICE, db_session, "POST", f"/api/remote/devices/{dev['id']}/connect")
    sid2 = r.json()["session"]["id"]
    r = await _req(None, db_session, "POST", f"/api/remote/host/sessions/{sid2}/decision", headers=hdr, json={"allow": False})
    assert r.json()["session"]["status"] == "denied"


async def test_host_cannot_touch_other_device_session(db_session):
    dev, hdr = await _register(db_session)
    dev2, hdr2 = await _register(db_session, user=BOB)
    r = await _req(ALICE, db_session, "POST", f"/api/remote/devices/{dev['id']}/connect")
    sid = r.json()["session"]["id"]
    r = await _req(None, db_session, "POST", f"/api/remote/host/sessions/{sid}/decision", headers=hdr2, json={"allow": True})
    assert r.status_code == 404


async def test_unattended_flag_only_for_owner(db_session):
    dev, hdr = await _register(db_session, unattended=True)
    r = await _req(ADMIN, db_session, "POST", f"/api/remote/devices/{dev['id']}/connect")
    r = await _req(None, db_session, "GET", "/api/remote/host/poll", headers=hdr)
    assert r.json()["sessions"][0]["auto_allow"] is False  # 관리자 요청은 항상 동의 필요
    await _req(ADMIN, db_session, "POST", f"/api/remote/sessions/{r.json()['sessions'][0]['id']}/end")
    await _req(ALICE, db_session, "POST", f"/api/remote/devices/{dev['id']}/connect")
    r = await _req(None, db_session, "GET", "/api/remote/host/poll", headers=hdr)
    assert r.json()["sessions"][0]["auto_allow"] is True


async def test_revoke_kills_host_and_sessions(db_session):
    dev, hdr = await _register(db_session)
    r = await _req(ALICE, db_session, "POST", f"/api/remote/devices/{dev['id']}/connect")
    sid = r.json()["session"]["id"]
    r = await _req(ALICE, db_session, "DELETE", f"/api/remote/devices/{dev['id']}")
    assert r.status_code == 200
    assert (await _fresh(db_session, RemoteSession, sid)).status == "ended"
    r = await _req(None, db_session, "GET", "/api/remote/host/poll", headers=hdr)
    assert r.status_code == 401


# ── 1회성 지원 ──

async def _code(db, ip=None):
    r = await _req(None, db, "POST", "/api/remote/support/code", ip=ip)
    assert r.status_code == 201, r.text
    j = r.json()
    return j, {"X-Remote-Support": f"{j['session_id']}:{j['host_secret']}"}


async def test_support_flow_one_time(db_session, _env):
    j, hdr = await _code(db_session)
    assert len(j["code"]) == 11 and j["code"][3] == "-"
    row = await _fresh(db_session, RemoteSession, j["session_id"])
    assert row.code_hash and j["code"].replace("-", "") not in row.code_hash  # HMAC 만 저장
    r = await _req(None, db_session, "GET", "/api/remote/support/poll", headers=hdr)
    assert r.json()["session"]["status"] == "waiting_code"
    r = await _req(BOB, db_session, "POST", "/api/remote/support/join", json={"code": j["code"]})
    assert r.status_code == 201 and r.json()["session"]["status"] == "pending"
    # 동일 코드 재사용 불가
    r = await _req(ALICE, db_session, "POST", "/api/remote/support/join", json={"code": j["code"]})
    assert r.status_code == 404
    r = await _req(None, db_session, "GET", "/api/remote/support/poll?since=waiting_code", headers=hdr)
    assert r.json()["session"]["requester_name"] == "밥" and r.json()["org_name"]
    r = await _req(None, db_session, "POST", "/api/remote/support/decision", headers=hdr, json={"allow": True})
    assert r.status_code == 200 and _claims(r.json()["livekit"]["token"])["video"]["canPublishSources"] == ["screen_share"]
    r = await _req(BOB, db_session, "GET", f"/api/remote/sessions/{j['session_id']}?token=1")
    assert "livekit" in r.json()
    r = await _req(ALICE, db_session, "GET", f"/api/remote/sessions/{j['session_id']}?token=1")
    assert r.status_code == 404  # 다른 회원은 조회 불가
    r = await _req(None, db_session, "POST", "/api/remote/support/end", headers=hdr)
    assert r.json()["session"]["status"] == "ended"


async def test_support_code_expiry_and_close(db_session):
    j, hdr = await _code(db_session)
    row = await _fresh(db_session, RemoteSession, j["session_id"])
    row.expires_at = svc.now() - timedelta(seconds=1)
    await db_session.commit()
    r = await _req(BOB, db_session, "POST", "/api/remote/support/join", json={"code": j["code"]})
    assert r.status_code == 404
    j2, hdr2 = await _code(db_session)
    await _req(None, db_session, "POST", "/api/remote/support/end", headers=hdr2)  # 프로그램 종료
    r = await _req(BOB, db_session, "POST", "/api/remote/support/join", json={"code": j2["code"]})
    assert r.status_code == 404


async def test_support_secret_required(db_session):
    j, hdr = await _code(db_session)
    r = await _req(None, db_session, "GET", "/api/remote/support/poll", headers={"X-Remote-Support": f"{j['session_id']}:nope"})
    assert r.status_code == 401
    r = await _req(None, db_session, "POST", "/api/remote/support/decision", json={"allow": True})
    assert r.status_code == 401


async def test_support_code_rate_limit_per_ip(db_session):
    ip = "10.250.250.1"
    for _ in range(10):
        await _code(db_session, ip=ip)
    r = await _req(None, db_session, "POST", "/api/remote/support/code", ip=ip)
    assert r.status_code == 429


async def test_support_join_failure_lockout(db_session):
    for _ in range(rr.JOIN_FAIL_LIMIT):
        r = await _req(ALICE, db_session, "POST", "/api/remote/support/join", json={"code": "000-000-001"})
        assert r.status_code == 404
    j, _ = await _code(db_session)
    r = await _req(ALICE, db_session, "POST", "/api/remote/support/join", json={"code": j["code"]})
    assert r.status_code == 429  # 올바른 코드여도 일시 차단


async def test_module_disabled_blocks_everything(db_session, monkeypatch):
    from app.modules import registry
    monkeypatch.setitem(registry._module_states, "remote-desktop", False)
    r = await _req(ALICE, db_session, "GET", "/api/remote/devices")
    assert r.status_code == 403
    r = await _req(None, db_session, "POST", "/api/remote/support/code")
    assert r.status_code == 403


async def test_audit_admin_only_and_recorded(db_session):
    dev, hdr = await _register(db_session)
    r = await _req(ALICE, db_session, "POST", f"/api/remote/devices/{dev['id']}/connect")
    sid = r.json()["session"]["id"]
    await _req(None, db_session, "POST", f"/api/remote/host/sessions/{sid}/decision", headers=hdr, json={"allow": True})
    await _req(ALICE, db_session, "GET", f"/api/remote/sessions/{sid}?token=1")
    await _req(ALICE, db_session, "POST", f"/api/remote/sessions/{sid}/end")
    r = await _req(ALICE, db_session, "GET", "/api/remote/audit")
    assert r.status_code == 403
    r = await _req(ADMIN, db_session, "GET", f"/api/remote/audit?session_id={sid}")
    acts = [e["action"] for e in r.json()["events"]]
    for a in ("session.requested", "session.approved", "token.viewer", "session.ended"):
        assert a in acts, acts
    assert all(e["ip"] for e in r.json()["events"])


def test_code_helpers():
    c = svc.new_code()
    assert len(c) == 9 and c.isdigit()
    assert svc.normalize_code("123-456 789") == "123456789"
    assert svc.normalize_code("12345678") is None and svc.normalize_code("1234567890") is None
    assert svc.code_hash("123456789") != svc.code_hash("123456780")
    assert svc.format_code("123456789") == "123-456-789"


async def test_support_download_anonymous(db_session):
    r = await _req(None, db_session, "GET", "/api/remote/support/download")
    assert r.status_code == 404  # 아직 업로드 전
    p = rr._support_exe()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"MZ-test")
    try:
        r = await _req(None, db_session, "GET", "/api/remote/support/download")
        assert r.status_code == 200 and r.content == b"MZ-test"
        assert "RemoteSupport.exe" in r.headers.get("content-disposition", "")
    finally:
        p.unlink()


# ── 화면 보강분 ──

def _variant(code: str, i: int) -> str:
    """i 번째 자리만 변경한 코드(한 자리 차이 = 해당 코드를 대상으로 한 오류 입력)"""
    d = code.replace("-", "")
    return d[:i] + str((int(d[i]) + 1) % 10) + d[i + 1:]


async def test_code_burned_after_five_near_misses(db_session):
    j, hdr = await _code(db_session)
    for i in range(svc.MAX_CODE_ATTEMPTS):
        r = await _req(BOB, db_session, "POST", "/api/remote/support/join", json={"code": _variant(j["code"], i)})
        assert r.status_code == 404 and r.json()["detail"]["code"] == "no_match"
    row = await _fresh(db_session, RemoteSession, j["session_id"])
    assert row.status == "expired" and row.end_reason == "code_attempts" and row.code_hash is None
    r = await _req(ALICE, db_session, "POST", "/api/remote/support/join", json={"code": j["code"]})
    assert r.status_code == 404  # 올바른 코드여도 이미 폐기됨
    r = await _req(None, db_session, "GET", "/api/remote/support/poll", headers=hdr)
    assert r.json()["session"]["status"] == "expired"  # 지원 프로그램도 폐기를 인지


async def test_four_near_misses_then_correct_code_works(db_session):
    j, _ = await _code(db_session)
    for i in range(svc.MAX_CODE_ATTEMPTS - 1):
        await _req(BOB, db_session, "POST", "/api/remote/support/join", json={"code": _variant(j["code"], i)})
    r = await _req(BOB, db_session, "POST", "/api/remote/support/join", json={"code": j["code"]})
    assert r.status_code == 201


async def test_far_wrong_codes_do_not_burn(db_session):
    j, _ = await _code(db_session)
    d = j["code"].replace("-", "")
    far = "".join(str((int(c) + 5) % 10) for c in d)  # 모든 자리가 상이
    for _ in range(6):
        await _req(BOB, db_session, "POST", "/api/remote/support/join", json={"code": far})
    assert (await _fresh(db_session, RemoteSession, j["session_id"])).status == "waiting_code"


async def test_join_error_codes_and_formats(db_session):
    r = await _req(BOB, db_session, "POST", "/api/remote/support/join", json={"code": "48a-913-057"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "format"
    r = await _req(BOB, db_session, "POST", "/api/remote/support/join", json={"code": "111-222-333"})
    assert r.json()["detail"]["code"] == "no_match" and "일치하는" in r.json()["detail"]["message"]
    j, _ = await _code(db_session)
    row = await _fresh(db_session, RemoteSession, j["session_id"])
    row.expires_at = svc.now() - timedelta(seconds=1)
    await db_session.commit()
    r = await _req(BOB, db_session, "POST", "/api/remote/support/join", json={"code": j["code"]})
    assert r.json()["detail"]["code"] == "expired" and "만료" in r.json()["detail"]["message"]
    # 공백·하이픈·붙여 쓰기 모두 허용
    for fmt in (lambda c: c.replace("-", " "), lambda c: c, lambda c: c.replace("-", "")):
        j, _ = await _code(db_session)
        r = await _req(ALICE, db_session, "POST", "/api/remote/support/join", json={"code": fmt(j["code"])})
        assert r.status_code == 201, (fmt(j["code"]), r.text)


async def test_device_sessions_owner_only(db_session):
    dev, hdr = await _register(db_session)
    r = await _req(ALICE, db_session, "POST", f"/api/remote/devices/{dev['id']}/connect")
    sid = r.json()["session"]["id"]
    await _req(None, db_session, "POST", f"/api/remote/host/sessions/{sid}/decision", headers=hdr, json={"allow": True})
    await _req(ALICE, db_session, "POST", f"/api/remote/sessions/{sid}/end")
    r = await _req(ADMIN, db_session, "POST", f"/api/remote/devices/{dev['id']}/connect")
    sid2 = r.json()["session"]["id"]
    await _req(None, db_session, "POST", f"/api/remote/host/sessions/{sid2}/decision", headers=hdr, json={"allow": False})
    r = await _req(ALICE, db_session, "GET", f"/api/remote/devices/{dev['id']}/sessions")
    assert r.status_code == 200
    ss = r.json()["sessions"]
    assert [s["status"] for s in ss] == ["denied", "ended"]
    assert ss[1]["requester_email"] == "al@x" and ss[1]["duration_s"] is not None and ss[0]["duration_s"] is None
    for other in (BOB, ADMIN):  # 타 사용자 기기 기록은 관리자도 이 API 로는 조회 불가(감사는 /audit)
        r = await _req(other, db_session, "GET", f"/api/remote/devices/{dev['id']}/sessions")
        assert r.status_code == 404
    r = await _req(ALICE, db_session, "GET", f"/api/remote/devices/{dev['id']}/sessions?limit=1")
    assert len(r.json()["sessions"]) == 1


async def test_rename_and_os_name(db_session):
    r = await _req(ALICE, db_session, "POST", "/api/remote/devices", json={"name": "PC", "platform": "win32", "os_name": "Windows 11"})
    dev = r.json()["device"]
    assert dev["os_name"] == "Windows 11"
    r = await _req(ALICE, db_session, "PATCH", f"/api/remote/devices/{dev['id']}", json={"name": "기완-데스크톱"})
    assert r.json()["device"]["name"] == "기완-데스크톱"
    r = await _req(BOB, db_session, "PATCH", f"/api/remote/devices/{dev['id']}", json={"name": "x"})
    assert r.status_code == 404


async def test_status_support_file_info_and_consent_fields(db_session):
    r = await _req(ALICE, db_session, "GET", "/api/remote/status")
    j = r.json()
    assert j["support_available"] is False and j["support_size"] is None and j["support_requirements"]
    assert j["org_domain"] == "localhost"
    p = rr._support_exe()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * 1234)
    try:
        j = (await _req(ALICE, db_session, "GET", "/api/remote/status")).json()
        assert j["support_available"] is True and j["support_size"] == 1234
    finally:
        p.unlink()
    # 동의 창에 사용할 요청자 이메일·조직 도메인이 호스트 폴링에 포함된다
    dev, hdr = await _register(db_session)
    await _req(ALICE, db_session, "POST", f"/api/remote/devices/{dev['id']}/connect")
    r = await _req(None, db_session, "GET", "/api/remote/host/poll", headers=hdr)
    assert r.json()["sessions"][0]["requester_email"] == "al@x" and r.json()["org_domain"] == "localhost"


def test_neighbor_codes():
    n = svc.neighbor_codes("123456789")
    assert len(n) == 81 and len(set(n)) == 81 and "123456789" not in n
    assert all(sum(a != b for a, b in zip(c, "123456789")) == 1 for c in n)
