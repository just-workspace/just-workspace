"""회의 목록 노출 범위 — 진행 중 회의는 호스트·초대 대상·(초대 링크로) 이미 입장한 사용자에게만 노출된다.

기존에는 진행 중인 회의가 로그인 사용자 전원의 목록에 공유 링크와 함께 포함되어, 대기실·비밀번호가 없는 회의는
목록에서 선택하여 누구나 입장할 수 있었다.

- 타인의 진행 중 회의는 목록에 없다(공유 링크도, 대기 인원도 반환하지 않는다)
- 초대 대상은 조회 가능하나 공유 링크는 받지 않는다(계정 초대는 링크 없이 즉시 입장)
- 링크로 입장한 로그인 사용자는 해당 회의를 조회하고, 본인이 사용한 링크를 받는다
- 링크 입장 자체는 변경 없다(대기실·비밀번호 동작 포함) — 목록에 노출되지 않아도 링크만 있으면 입장한다
- 방 이름을 직접 입력해도 토큰은 호스트·계정 초대 대상에게만 발급된다
- 동일 이름으로 다시 생성한 회의에는 이전 링크 입장 기록이 승계되지 않는다
"""

import pytest
from fastapi import HTTPException

from app.meetings import router as mr
from app.meetings import store
from app.meetings.schemas import JoinRequestCreate, RoomCreate, TokenRequest
from tests.test_meetings_store_db import _create, _u, env  # noqa: F401  (픽스처 재사용)


async def _rooms(env, uid):
    return {r.name: r for r in (await mr.get_rooms(user=await _u(env, uid), db=env["db"])).rooms}


async def _live(env, name="kickoff", n=2):
    env["lk"]["rooms"][name] = {"name": name, "num_participants": n, "max_participants": 10, "creation_time": 1}


async def test_live_meeting_hidden_from_uninvited(env):
    info = await _create(env, waiting_room=False)      # 대기실·비밀번호 없는 회의 — 기존에는 누구나 선택하여 입장 가능
    await _live(env)
    await store.create_join_request("kickoff", "대기 손님")

    alice = (await _rooms(env, "alice"))["kickoff"]
    assert alice.status == "live" and alice.is_host and alice.share_token == info.share_token
    assert alice.pending_count == 1

    bob = (await _rooms(env, "bob"))["kickoff"]            # 계정으로 초대받은 사용자
    assert bob.status == "live" and not bob.is_host and bob.my_response == "pending"
    assert bob.share_token == "" and bob.pending_count == 0

    assert "kickoff" not in await _rooms(env, "carol")     # 초대받지 않은 사용자에게는 방 자체가 미노출


async def test_instant_meeting_only_for_host(env):
    await mr.create_room(RoomCreate(name="standup"), user=await _u(env, "carol"), db=env["db"])
    assert (await _rooms(env, "carol"))["standup"].is_host
    assert "standup" not in await _rooms(env, "alice")
    assert "standup" not in await _rooms(env, "bob")


async def test_room_without_meta_is_listed_to_nobody(env):
    await _live(env, "떠도는-방")
    for uid in ("alice", "bob", "carol"):
        assert "떠도는-방" not in await _rooms(env, uid)


async def test_link_holder_still_joins_and_then_sees_room(env):
    info = await _create(env, waiting_room=False)
    await _live(env)
    carol = await _u(env, "carol")
    assert "kickoff" not in await _rooms(env, "carol")

    # 목록에 노출되지 않아도 링크로는 입장 가능(대기실 비활성 → 즉시 입장)
    res = await mr.submit_join_request(info.share_token, JoinRequestCreate(nickname="Carol"), link_uid="carol")
    assert res.status == "approved" and res.token

    room = (await _rooms(env, "carol"))["kickoff"]         # 이후 본인이 참여 중인 회의로 표시
    assert room.status == "live" and not room.is_host
    assert room.share_token == info.share_token            # 본인이 사용한 링크
    assert room.pending_count == 0
    # 호스트 전용·초대 대상 전용 정보는 여전히 비공개
    with pytest.raises(HTTPException) as e:
        await mr.get_meeting(info.meeting_id, user=carol, db=env["db"])
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        await mr.create_token(TokenRequest(room="kickoff"), user=carol, db=env["db"])
    assert e.value.status_code == 403


async def test_anonymous_link_join_unchanged(env):
    """로그인하지 않은 손님(라우터 밖 직접 호출 = user 가 Depends 객체) — 기존과 동일, 기록도 남지 않는다."""
    info = await _create(env)                              # 대기실 활성
    res = await mr.submit_join_request(info.share_token, JoinRequestCreate(nickname="손님"))
    assert res.status == "pending"
    res = await mr.submit_join_request(info.share_token, JoinRequestCreate(nickname="손님"), link_uid=None)
    assert res.status == "pending"
    assert store._LKEY + "kickoff" not in env["redis"].kv


async def test_waiting_room_and_password_unchanged_for_logged_in_link_holder(env):
    info = await _create(env, password="4454")
    carol = await _u(env, "carol")
    with pytest.raises(HTTPException) as e:
        await mr.submit_join_request(info.share_token, JoinRequestCreate(nickname="C", password="0000"), link_uid="carol")
    assert e.value.status_code == 403
    ok = await mr.submit_join_request(info.share_token, JoinRequestCreate(nickname="C", password="4454"), link_uid="carol")
    assert ok.status == "approved"
    # 비밀번호 없이 요청하면 대기실
    wait = await mr.submit_join_request(info.share_token, JoinRequestCreate(nickname="C"), link_uid="carol")
    assert wait.status == "pending"


async def test_bad_link_records_nothing(env):
    await _create(env)
    with pytest.raises(HTTPException) as e:
        await mr.submit_join_request("0" * 32, JoinRequestCreate(nickname="C"), link_uid="carol")
    assert e.value.status_code == 404
    assert "kickoff" not in await _rooms(env, "carol")


async def test_typing_room_name_gives_no_token(env):
    await _create(env, waiting_room=False)
    await _live(env)
    carol = await _u(env, "carol")
    with pytest.raises(HTTPException) as e:
        await mr.create_token(TokenRequest(room="kickoff"), user=carol, db=env["db"])
    assert e.value.status_code == 403
    with pytest.raises(HTTPException) as e:
        await mr.create_token(TokenRequest(room="없는-방"), user=carol, db=env["db"])
    assert e.value.status_code == 404
    # 호스트·계정 초대 대상은 변경 없음
    assert (await mr.create_token(TokenRequest(room="kickoff"), user=await _u(env, "alice"), db=env["db"])).is_host
    assert (await mr.create_token(TokenRequest(room="kickoff"), user=await _u(env, "bob"), db=env["db"])).token


async def test_link_record_dropped_when_room_ends_or_is_recreated(env):
    info = await _create(env, waiting_room=False)
    await _live(env)
    carol = await _u(env, "carol")
    await mr.submit_join_request(info.share_token, JoinRequestCreate(nickname="C"), link_uid="carol")
    assert await store.is_link_user("kickoff", "carol")

    await mr.end_room("kickoff", user=await _u(env, "alice"), db=env["db"])
    assert not await store.is_link_user("kickoff", "carol")

    # 기록이 잔존하더라도(자연 만료 전) 동일 이름의 새 회의에는 승계되지 않음
    await store.remember_link_user("kickoff", "carol")
    info2 = await _create(env, waiting_room=False)
    await _live(env)
    assert info2.share_token != info.share_token
    assert "kickoff" not in await _rooms(env, "carol")


async def test_recording_status_only_for_people_who_can_see_room(env):
    info = await _create(env, waiting_room=False)
    await _live(env)
    await store.set_active_recording("kickoff", "EG_1", "kickoff_x.mp4")
    for uid in ("alice", "bob"):
        res = await mr.recording_status("kickoff", user=await _u(env, uid), db=env["db"])
        assert res == {"recording": True, "filename": "kickoff_x.mp4"}
    carol = await _u(env, "carol")
    assert await mr.recording_status("kickoff", user=carol, db=env["db"]) == {"recording": False, "filename": None}
    await mr.submit_join_request(info.share_token, JoinRequestCreate(nickname="C"), link_uid="carol")
    assert (await mr.recording_status("kickoff", user=carol, db=env["db"]))["recording"] is True


async def test_email_match_binds_local_accounts_only(env):
    """초대 주소 == 계정 주소 연결은 로컬 계정만 대상 — LDAP 계정의 주소는 디렉터리 값이 덮어쓴다(본인이 변경할 수 있다)."""
    from app.db.models import User

    await _create(env, waiting_room=False)             # 초대: bob(계정) + guest@ext(주소)
    await _live(env)
    env["db"].add(User(id="dave", username="dave", email="Guest@Ext", password_hash="x", display_name="Dave"))
    env["db"].add(User(id="lena", username="lena", email="guest@ext", password_hash=None, display_name="Lena",
                       auth_source="ldap"))
    await env["db"].commit()

    # 로컬 계정: 목록에 노출되고 즉시 입장
    assert (await _rooms(env, "dave"))["kickoff"].my_response == "pending"
    assert (await mr.create_token(TokenRequest(room="kickoff"), user=await _u(env, "dave"), db=env["db"])).token
    # 외부 인증 계정: 목록에도 없고(노출되나 403 인 경우 방지) 토큰도 없음 — 초대 링크로는 입장 가능
    lena = await _u(env, "lena")
    assert "kickoff" not in await _rooms(env, "lena")
    with pytest.raises(HTTPException) as e:
        await mr.create_token(TokenRequest(room="kickoff"), user=lena, db=env["db"])
    assert e.value.status_code == 403
    env["lk"]["rooms"].clear()                              # 예정 회의 목록(DB 측)에도 없음
    assert "kickoff" not in await _rooms(env, "lena")


async def test_ldap_account_invited_by_account_still_enters(env):
    from app.db.models import User
    from app.meetings.schemas import InviteeItem

    env["db"].add(User(id="lena", username="lena", email="lena@dir", password_hash=None, display_name="Lena",
                       auth_source="ldap"))
    await env["db"].commit()
    await mr.create_room(RoomCreate(name="sync", invitees=[InviteeItem(type="internal", user_id="lena")]),
                         user=await _u(env, "alice"), db=env["db"])
    assert "sync" in await _rooms(env, "lena")
    assert (await mr.create_token(TokenRequest(room="sync"), user=await _u(env, "lena"), db=env["db"])).token


async def test_closed_meeting_with_leftover_livekit_room_is_not_live_for_invitee(env):
    """행은 종료되었으나 LiveKit 방이 잔존한 경우 — 초대 대상에게 "진행 중"으로 포함하지 않는다(포함 시 [참여]가 403)."""
    from app.db.models import MeetingDB

    info = await _create(env)
    row = await env["db"].get(MeetingDB, info.meeting_id)
    row.status = "ended"
    await env["db"].commit()
    await _live(env)                                        # 메타(Redis)와 방은 잔존

    bob = (await _rooms(env, "bob"))["kickoff"]
    assert bob.status == "ended"                            # 지난 회의로만 표시
    with pytest.raises(HTTPException) as e:
        await mr.create_token(TokenRequest(room="kickoff"), user=await _u(env, "bob"), db=env["db"])
    assert e.value.status_code == 403


async def test_optional_user_failure_is_anonymous(env, monkeypatch):
    """로그인 사용자 판독이 어떤 원인으로 실패하든(DB 장애 포함) 손님 입장은 익명으로 정상 처리된다."""
    async def boom(*a, **kw):
        raise RuntimeError("db down")

    monkeypatch.setattr(mr, "get_current_user", boom)
    assert await mr._optional_user_id(request=None, ws_session="x") is None

    def no_session():
        raise RuntimeError("pool exhausted")

    monkeypatch.setattr(mr.repo, "session", no_session)
    assert await mr._optional_user_id(request=None, ws_session="x") is None
