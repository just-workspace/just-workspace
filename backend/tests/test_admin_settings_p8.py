"""관리 콘솔 — 로그인 보호 정책 API, 저장소 요약·사용자 기본 할당(업로드 집행), SMTP 마지막 시험,
백업 대상 표시, 앱 빌드 산출물, AI 모델 상태 시험. 관리자 전용인지도 본다."""

import io
import os
import sys
import types

if os.name == "nt" and "resource" not in sys.modules:  # files.indexer 가 유닉스 전용 resource 를 import
    sys.modules["resource"] = types.ModuleType("resource")

import pytest
from fastapi import HTTPException, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from starlette.requests import Request

import app.ai.models  # noqa: F401
import app.backup.models  # noqa: F401
import app.groups.models  # noqa: F401
from app.admin import router as admin_router
from app.admin import settings_ext
from app.ai import config as ai_config
from app.ai import router as ai_router
from app.apps import router as apps_router
from app.auth import security_policy
from app.backup import router as backup_router
from app.db.models import Base, User
from app.files import quota as file_quota
from app.files import router as files_router


def _req():
    return Request({"type": "http", "method": "PUT", "path": "/", "query_string": b"", "headers": [],
                    "client": ("10.0.0.1", 1), "server": ("t", 80), "scheme": "http"})


@pytest.fixture()
async def db(monkeypatch, tmp_path):
    security_policy.invalidate_cache()
    monkeypatch.setattr(file_quota.get_settings(), "storage_root", str(tmp_path))
    engine = create_async_engine("sqlite+aiosqlite:///", echo=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    async with async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)() as s:
        s.add(User(id="root", username="root", email="root@x", password_hash="x", is_admin=True))
        s.add(User(id="alice", username="alice", email="alice@x", password_hash="x"))
        await s.commit()
        yield s
    await engine.dispose()
    security_policy.invalidate_cache()


@pytest.mark.asyncio
async def test_security_policy_api(db):
    root = await db.get(User, "root")
    res = await settings_ext.get_security_policy(admin=root, db=db)
    assert res["require_2fa"] == "off" and res["lockout_threshold"] == 5 and 0 in res["idle_choices"]

    # 본인이 2단계를 안 켠 관리자는 "관리자 필수"를 켤 수 없다(켜는 순간 갇힘)
    with pytest.raises(HTTPException) as e:
        await settings_ext.put_security_policy(settings_ext.SecurityPolicyUpdate(require_2fa="admins"), _req(), admin=root, db=db)
    assert e.value.status_code == 400
    root.totp_secret = "JBSWY3DPEHPK3PXP"
    await db.commit()
    res = await settings_ext.put_security_policy(
        settings_ext.SecurityPolicyUpdate(require_2fa="admins", lockout_enabled=True, new_device_alert=True,
                                          idle_timeout_minutes=60), _req(), admin=root, db=db)
    assert res["require_2fa"] == "admins" and res["lockout_enabled"] and res["new_device_alert"]
    assert res["idle_timeout_minutes"] == 60
    # 저장하면 캐시도 비워져 바로 반영
    assert (await security_policy.get_policy_cached(db))["require_2fa"] == "admins"
    with pytest.raises(HTTPException):
        await settings_ext.put_security_policy(settings_ext.SecurityPolicyUpdate(idle_timeout_minutes=5), _req(), admin=root, db=db)

    alice = await db.get(User, "alice")
    with pytest.raises(HTTPException) as e:  # 관리자 전용
        await admin_router.require_admin(user=alice)
    assert e.value.status_code == 403


@pytest.mark.asyncio
async def test_storage_summary_and_quota(db):
    root = await db.get(User, "root")
    res = await settings_ext.storage_summary(admin=root, db=db)
    assert res["user_quota_gb"] == 0 and res["trash_retention_days"] == 30 and res["disk_total"] >= 0
    with pytest.raises(HTTPException):
        await settings_ext.put_storage_quota(settings_ext.QuotaUpdate(user_quota_gb=-1), _req(), admin=root, db=db)
    await settings_ext.put_storage_quota(settings_ext.QuotaUpdate(user_quota_gb=1), _req(), admin=root, db=db)
    assert (await settings_ext.storage_summary(admin=root, db=db))["user_quota_gb"] == 1


@pytest.mark.asyncio
async def test_quota_rules(db, monkeypatch):
    alice = await db.get(User, "alice")
    # 제한 없음
    assert await file_quota.room_left(db, alice, "my/docs") is None
    await settings_ext.put_storage_quota(settings_ext.QuotaUpdate(user_quota_gb=1), _req(),
                                         admin=await db.get(User, "root"), db=db)

    async def _used(uid):
        return file_quota.GB - 100  # 100 바이트 남음

    monkeypatch.setattr(file_quota, "personal_usage", _used)
    assert await file_quota.room_left(db, alice, "my") == 100
    assert await file_quota.room_left(db, alice, "shared/team") is None  # 공유 폴더는 개인 할당 밖
    assert await file_quota.room_left(db, alice, "myfiles") is None
    assert await file_quota.ensure_room(db, alice, "my/a", 50) == 100
    with pytest.raises(HTTPException) as e:
        await file_quota.ensure_room(db, alice, "my/a", 101)
    assert e.value.status_code == 413


@pytest.mark.asyncio
async def test_upload_blocked_over_quota(db, monkeypatch, tmp_path):
    alice = await db.get(User, "alice")
    await settings_ext.put_storage_quota(settings_ext.QuotaUpdate(user_quota_gb=1), _req(),
                                         admin=await db.get(User, "root"), db=db)

    async def _used(uid):
        return file_quota.GB - 10

    monkeypatch.setattr(file_quota, "personal_usage", _used)
    target = tmp_path / "users" / "alice"
    target.mkdir(parents=True)
    from app.files import access as acc

    async def _target(db_, path, user):
        return "my", target, acc.Access(vp="my", real=target, role="owner", owner_id=user.id,
                                        owner_vpath="my", share=None, key=f"users/{user.id}")

    monkeypatch.setattr(files_router, "_upload_target", _target)
    up = UploadFile(filename="big.bin", file=io.BytesIO(b"x" * 64))
    with pytest.raises(HTTPException) as e:  # 선언 크기 0 이어도 기록 중에 넘치면 멈추고 지운다
        await files_router.upload_file(up, path="my/", upload_id=None, size=0, mtime=None, x_file_mtime=None,
                                       user=alice, db=db)
    assert e.value.status_code == 413
    assert not (target / "big.bin").exists()

    with pytest.raises(HTTPException) as e:  # 큰 파일 재개 업로드 세션도 시작 전에 거른다
        await files_router.create_upload_session(
            files_router.UploadSessionCreate(name="big.bin", path="my/", size=64), user=alice, db=db)
    assert e.value.status_code == 413


@pytest.mark.asyncio
async def test_smtp_last_test_recorded(db, monkeypatch):
    root = await db.get(User, "root")

    def _boom(cfg, msg):
        raise RuntimeError("no server")

    monkeypatch.setattr(admin_router, "send_system_email", _boom)
    with pytest.raises(HTTPException):
        await admin_router.test_smtp(admin_router.SmtpTestRequest(to_email="a@x"), admin=root, db=db)
    res = await admin_router.get_smtp(admin=root, db=db)
    assert res["last_test_at"] and res["last_test_ok"] is False
    monkeypatch.setattr(admin_router, "send_system_email", lambda cfg, msg: None)
    await admin_router.test_smtp(admin_router.SmtpTestRequest(to_email="a@x"), admin=root, db=db)
    assert (await admin_router.get_smtp(admin=root, db=db))["last_test_ok"] is True


@pytest.mark.asyncio
async def test_backup_target_and_app_artifacts(db, tmp_path, monkeypatch):
    root = await db.get(User, "root")
    sched = await backup_router.schedule_get(user=root, db=db)
    assert sched["target"]
    monkeypatch.setattr(apps_router.settings, "storage_root", str(tmp_path))
    (tmp_path / "apps").mkdir()
    (tmp_path / "apps" / "workspace-android.apk").write_bytes(b"apk" * 10)
    res = await apps_router.artifacts(user=root)
    by = {a["platform"]: a for a in res["artifacts"]}
    assert by["android"]["available"] and by["android"]["size_bytes"] == 30 and by["android"]["modified_at"]
    assert by["desktop"]["available"] is False
    with pytest.raises(HTTPException):
        await apps_router.artifacts(user=await db.get(User, "alice"))


@pytest.mark.asyncio
async def test_ai_config_test_and_advanced(db, monkeypatch):
    root = await db.get(User, "root")
    res = await ai_router.test_config(ai_router.ConfigTest(), user=root, db=db)
    assert res["status"] == "unconfigured"
    await ai_config.set_ai_config(db, kind="ollama", model="small:8b", base_url="http://127.0.0.1:9", advanced_model="big:70b")

    async def _models(cfg):
        return ["small:8b"]

    monkeypatch.setattr(ai_router, "list_models", _models)
    res = await ai_router.test_config(ai_router.ConfigTest(), user=root, db=db)
    assert res["ok"] and res["status"] == "ok" and res["model"] == "small:8b" and res["ms"] is not None
    res = await ai_router.test_config(ai_router.ConfigTest(advanced=True), user=root, db=db)
    assert res["status"] == "not_found" and res["model"] == "big:70b"
    with pytest.raises(HTTPException):
        await ai_router.test_config(ai_router.ConfigTest(), user=await db.get(User, "alice"), db=db)
    cfg = await ai_config.get_ai_config(db)
    assert cfg["advanced_model"] == "big:70b" and cfg["governance"]["daily_limit"] == 0
