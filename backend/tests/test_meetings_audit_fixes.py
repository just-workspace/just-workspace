"""화상회의 구역 감사 수정 회귀.

- 보안 2: 음성 채널 방 이름(voice-<채널id>)은 회의로 만들 수 없고, 토큰·목록·참여자 조회에 나오지 않는다
- 보안 3: 내 회의라는 근거(메타·DB 행)가 없는 방은 닫을 수 없고, 참여자 목록은 호스트·초대 대상만
- 1: 계정으로 초대받은 사람은 토큰을 받는다(호스트 아님) — 초대 안 된 사람·메일만 같은 사람은 여전히 403
- 12: 참가 신청은 방 메타 JSON 과 따로(해시) — 메타를 다시 써도 신청이 안 사라지고, 예전 메타 안 신청도 읽힌다
- 13: 방이 닫히면 녹화 상태를 내리고, 끝난 egress 를 멈추려다 실패해도 상태는 내려간다
"""

import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from sqlalchemy import delete

from app.db.models import MeetingInvitee, User
from app.meetings import router as mr
from app.meetings import store
from app.meetings.schemas import JoinRequestCreate, RoomCreate, TokenRequest
from tests.test_meetings_store_db import _create, _u, env  # noqa: F401  (픽스처 재사용)


# ── 2. voice- 예약 ──

@pytest.mark.parametrize("name", ["voice-c1", "VOICE-c1", "  voice-x"])
def test_voice_prefix_is_reserved(name):
    with pytest.raises(ValidationError):
        RoomCreate(name=name)
    assert RoomCreate(name="voiceover 회의").name == "voiceover 회의"


async def test_voice_room_has_no_meta_token_or_listing(env, monkeypatch):
    with pytest.raises(ValueError):
        await store.create_room_meta("voice-c1", "carol", "carol", "Carol")
    # 예전 코드로 선점된 메타가 Redis 에 남아 있어도 호스트 토큰은 안 나온다
    meta = store.RoomMeta(name="voice-c1", host_user_id="carol", host_username="carol", host_display_name="Carol")
    env["redis"].kv[store._RKEY + "voice-c1"] = store._serialize(meta)
    carol = await _u(env, "carol")
    with pytest.raises(HTTPException) as e:
        await mr.create_token(TokenRequest(room="voice-c1"), user=carol, db=env["db"])
    assert e.value.status_code == 404

    # 누가 음성 채널에 들어가 있어도 회의 목록에는 안 나온다(멤버 여부와 무관 — 회의가 아니다)
    from app.chat import service as chat_service

    async def is_member(_db, _channel_id, _user_id):
        return True

    monkeypatch.setattr(chat_service, "is_channel_member", is_member)
    env["lk"]["rooms"]["voice-c1"] = {"name": "voice-c1", "num_participants": 2,
                                      "max_participants": 10, "creation_time": 1}
    names = [r.name for r in (await mr.get_rooms(user=carol, db=env["db"])).rooms]
    assert "voice-c1" not in names

    async def parts(_room):
        return [{"identity": "u-1", "name": "Bob", "joined_at": 1, "mic_muted": False}]

    monkeypatch.setattr(mr.livekit, "list_participants", parts)
    with pytest.raises(HTTPException) as e:
        await mr.get_participants("voice-c1", user=carol, db=env["db"])
    assert e.value.status_code == 404


# ── 3. 메타 없는 방 삭제·참여자 조회 ──

@pytest.mark.parametrize("name", ["chan-c1", "voice-c1", "남의-즉석-방"])
async def test_cannot_delete_room_without_ownership(env, name):
    env["lk"]["rooms"][name] = {"name": name, "num_participants": 3, "max_participants": 10, "creation_time": 1}
    with pytest.raises(HTTPException) as e:
        await mr.delete_room(name, user=await _u(env, "carol"), db=env["db"])
    assert e.value.status_code == 404
    assert env["lk"]["deleted"] == [] and name in env["lk"]["rooms"]


async def test_host_can_still_delete_own_room(env):
    await _create(env)
    await mr.delete_room("kickoff", user=await _u(env, "alice"), db=env["db"])
    assert env["lk"]["deleted"] == ["kickoff"]
    with pytest.raises(HTTPException) as e:
        await mr.delete_room("kickoff", user=await _u(env, "carol"), db=env["db"])
    assert e.value.status_code in (403, 404)
    assert env["lk"]["deleted"] == ["kickoff"]


async def test_participants_only_for_host_and_invitees(env, monkeypatch):
    await _create(env)

    async def parts(_room):
        return [{"identity": "u-1", "name": "Alice", "joined_at": 1, "mic_muted": False}]

    monkeypatch.setattr(mr.livekit, "list_participants", parts)
    assert len(await mr.get_participants("kickoff", user=await _u(env, "alice"), db=env["db"])) == 1
    assert len(await mr.get_participants("kickoff", user=await _u(env, "bob"), db=env["db"])) == 1   # 초대 대상
    for name in ("kickoff", "없는-방"):
        with pytest.raises(HTTPException) as e:
            await mr.get_participants(name, user=await _u(env, "carol"), db=env["db"])
        assert e.value.status_code == 404


# ── 1. 초대받은 사람의 토큰 ──

async def test_invited_account_gets_token_but_not_host(env):
    await _create(env, password="s3cret")
    tok = await mr.create_token(TokenRequest(room="kickoff"), user=await _u(env, "bob"), db=env["db"])
    assert tok.token and tok.is_host is False
    # 초대 안 된 사람은 그대로 403 — 초대 링크(대기실·비밀번호)로 들어와야 한다
    with pytest.raises(HTTPException) as e:
        await mr.create_token(TokenRequest(room="kickoff"), user=await _u(env, "carol"), db=env["db"])
    assert e.value.status_code == 403
    # 호스트 전용 동작은 초대받은 사람에게 열리지 않는다
    with pytest.raises(HTTPException) as e:
        await mr.get_pending_requests("kickoff", user=await _u(env, "bob"))
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        await mr.start_recording("kickoff", user=await _u(env, "bob"), db=env["db"])
    assert e.value.status_code == 403


async def test_email_only_invite_grants_token_by_account_address_only(env):
    await _create(env)
    # 메일 주소(guest@ext)로만 초대됐는데 그 주소가 계정 주소인 내부 계정 — 계정 초대와 같게 바로 입장
    # (예전엔 목록에는 보이는데 [참여]가 403 이었다). 판정은 RSVP 가 계정에 묶을 때와 같다.
    env["db"].add(User(id="dave", username="dave", email="Guest@EXT", password_hash="x", display_name="Dave"))
    # 복구 메일만 같은 계정은 초대 대상이 아니다(복구 메일은 본인이 적는 값)
    env["db"].add(User(id="erin", username="erin", email="erin@x", recovery_email="guest@ext",
                       password_hash="x", display_name="Erin"))
    await env["db"].commit()
    tok = await mr.create_token(TokenRequest(room="kickoff"), user=await _u(env, "dave"), db=env["db"])
    assert tok.token and tok.is_host is False
    with pytest.raises(HTTPException) as e:
        await mr.create_token(TokenRequest(room="kickoff"), user=await _u(env, "erin"), db=env["db"])
    assert e.value.status_code == 403


async def test_removed_invitee_loses_token(env):
    info = await _create(env)
    await env["db"].execute(delete(MeetingInvitee).where(MeetingInvitee.meeting_id == info.meeting_id))
    await env["db"].commit()
    with pytest.raises(HTTPException) as e:
        await mr.create_token(TokenRequest(room="kickoff"), user=await _u(env, "bob"), db=env["db"])
    assert e.value.status_code == 403


# ── 12. 참가 신청 저장 ──

async def test_requests_survive_meta_rewrite(env):
    await _create(env)
    a = await store.create_join_request("kickoff", "손님A")
    # 다른 워커가 "신청이 없던 시점"에 읽은 메타를 뒤늦게 통째로 쓴다(예전엔 이때 신청이 사라졌다)
    stale = await store.get_room_meta("kickoff")
    b = await store.create_join_request("kickoff", "손님B")
    await store.set_join_request_status("kickoff", a.id, "approved", livekit_token="lk")
    await store.save_room_meta(stale)
    assert (await store.get_join_request("kickoff", a.id)).status == "approved"
    assert [r.id for r in await store.get_pending_requests("kickoff")] == [b.id]


async def test_legacy_requests_inside_meta_still_work(env):
    await _create(env)
    # 배포 전에 받은 신청 — 메타 JSON 안에 들어 있다
    meta = await store.get_room_meta("kickoff")
    meta.requests["old00001"] = store.JoinRequest(id="old00001", nickname="예전 손님")
    await store.save_room_meta(meta)
    assert [r.id for r in await store.get_pending_requests("kickoff")] == ["old00001"]
    await mr.approve_request("kickoff", "old00001", user=await _u(env, "alice"))
    st = await mr.get_request_status((await store.get_room_meta("kickoff")).share_token, "old00001")
    assert st.status == "approved" and st.token
    assert await store.get_pending_requests("kickoff") == []
    # 두 번 처리는 그대로 400
    with pytest.raises(HTTPException) as e:
        await mr.deny_request("kickoff", "old00001", user=await _u(env, "alice"))
    assert e.value.status_code == 400


async def test_guest_flow_end_to_end_with_hash(env):
    info = await _create(env)
    res = await mr.submit_join_request(info.share_token, JoinRequestCreate(nickname="손님"))
    assert res.status == "pending"
    assert [r.nickname for r in await mr.get_pending_requests("kickoff", user=await _u(env, "alice"))] == ["손님"]
    await mr.deny_request("kickoff", res.request_id, user=await _u(env, "alice"))
    assert (await mr.get_request_status(info.share_token, res.request_id)).status == "denied"
    # 방을 닫으면 신청도 같이 지워진다
    await mr.end_room("kickoff", user=await _u(env, "alice"), db=env["db"])
    assert store._QKEY + "kickoff" not in env["redis"].kv


async def test_guest_cancel_removes_pending_request(env):
    info = await _create(env)
    res = await mr.submit_join_request(info.share_token, JoinRequestCreate(nickname="손님"))
    assert (await mr.cancel_join_request(info.share_token, res.request_id))["status"] == "cancelled"
    assert await mr.get_pending_requests("kickoff", user=await _u(env, "alice")) == []
    # 취소된 신청은 승인되지 않는다(취소했는데 입장되는 일이 없게)
    with pytest.raises(HTTPException) as e:
        await mr.approve_request("kickoff", res.request_id, user=await _u(env, "alice"))
    assert e.value.status_code == 400
    # 이미 승인된 신청은 취소로 덮지 않는다
    res2 = await mr.submit_join_request(info.share_token, JoinRequestCreate(nickname="손님2"))
    await mr.approve_request("kickoff", res2.request_id, user=await _u(env, "alice"))
    assert (await mr.cancel_join_request(info.share_token, res2.request_id))["status"] == "approved"
    with pytest.raises(HTTPException) as e:
        await mr.cancel_join_request(info.share_token, "nope0000")
    assert e.value.status_code == 404


# ── 13. 녹화 상태 ──

async def test_stop_recording_clears_state_even_if_egress_already_finished(env, monkeypatch):
    await _create(env)
    await store.set_active_recording("kickoff", "EG_1", "kickoff_x.mp4")

    async def boom(_egress_id):
        raise RuntimeError("twirp error failed_precondition: egress with status EGRESS_COMPLETE cannot be stopped")

    monkeypatch.setattr(mr.livekit, "stop_recording", boom)
    res = await mr.stop_recording("kickoff", user=await _u(env, "alice"))
    assert res["recording"] is False
    assert await store.get_active_recording("kickoff") is None


async def test_ending_room_clears_recording_state(env):
    await _create(env)
    await store.set_active_recording("kickoff", "EG_1", "kickoff_x.mp4")
    await mr.end_room("kickoff", user=await _u(env, "alice"), db=env["db"])
    assert await store.get_active_recording("kickoff") is None
