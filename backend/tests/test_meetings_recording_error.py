"""녹화 시작 실패는 사용자용 문구 detail 과 함께 502 — 프런트가 토스트로 그대로 표시한다(원문 twirp 오류는 로그에 기록)."""

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.meetings import router as mr


async def test_start_failure_is_human_readable(monkeypatch):
    async def host(_name, _user):
        return SimpleNamespace(host_user_id="u1", meeting_id=None, chat_channel_id=None)

    async def no_active(_name):
        return None

    async def boom(_room):
        raise RuntimeError("twirp error unknown: no response from servers")

    monkeypatch.setattr(mr, "_check_configured", lambda: None)
    monkeypatch.setattr(mr, "_require_host", host)
    monkeypatch.setattr(mr.store, "get_active_recording", no_active)
    monkeypatch.setattr(mr.livekit, "start_recording", boom)
    with pytest.raises(HTTPException) as e:
        await mr.start_recording("room1", user=SimpleNamespace(id="u1"), db=None)
    assert e.value.status_code == 502
    assert "녹화 서버" in e.value.detail and "twirp" not in e.value.detail
