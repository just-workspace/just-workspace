"""chat22 — 첨부 묶음(POST /channels/{id}/attachments)·옛 단일 file_meta 호환·이미지 크기·413."""

import io
import json

import pytest
from fastapi import HTTPException, UploadFile

from app.chat import router as chat_router
from app.chat import router22, service
from tests.chat22_fixtures import db, events, flush_tasks, u  # noqa: F401


def _png(w=40, h=30) -> bytes:
    from PIL import Image
    b = io.BytesIO()
    Image.new("RGB", (w, h), (200, 10, 10)).save(b, "PNG")
    return b.getvalue()


def _up(data: bytes, name: str, ctype: str | None = None) -> UploadFile:
    from starlette.datastructures import Headers
    headers = Headers({"content-type": ctype}) if ctype else None
    return UploadFile(file=io.BytesIO(data), filename=name, headers=headers)


async def _attach(db, cid, uid, files, **kw):
    args = dict(content=None, spoilers=None, alts=None, reply_to_id=None, reply_ping=True, silent=False,
                parent_id=None, also_to_channel=False)
    args.update(kw)
    out = await router22.upload_attachments(channel_id=cid, files=files, user=await u(db, uid), db=db, **args)
    await flush_tasks()
    return out


@pytest.mark.asyncio
async def test_multi_attachments_one_message(db, events):
    ch = await service.create_channel(db, "gen", "public", "alice", member_ids=["bob"])
    msg = await _attach(db, ch.id, "alice", [
        _up(_png(), "a.png", "image/png"), _up(b"%PDF-1.4", "b.pdf", "application/pdf"),
        _up(b"RIFF", "c.mp3", "audio/mpeg"),
    ], content="자료 셋", spoilers="0,2,9", alts=json.dumps(["빨간 사각형", None]))
    assert msg["message_type"] == "file" and msg["content"] == "자료 셋"
    atts = msg["attachments"]
    assert [a["filename"] for a in atts] == ["a.png", "b.pdf", "c.mp3"]
    assert atts[0]["width"] == 40 and atts[0]["height"] == 30
    assert [a["spoiler"] for a in atts] == [True, False, True]
    assert atts[0]["alt"] == "빨간 사각형" and atts[1]["alt"] is None
    assert "disk_name" not in atts[0] and atts[0]["url"].startswith(f"/api/chat/channels/{ch.id}/files/")
    # 옛 프런트 호환 — file_meta = 첫 파일
    assert json.loads(msg["file_meta"])["filename"] == "a.png"
    # 답장 원문 요약에 첨부 종류
    r = await service.create_message(db, ch.id, "bob", "이미지 좋네요", reply_to_id=msg["id"])
    assert r["reply_to"]["has_attachment"] is True and r["reply_to"]["attachment_kind"] == "image"
    assert r["reply_to"]["content"] == "자료 셋"


@pytest.mark.asyncio
async def test_legacy_single_file_meta_becomes_one_attachment(db, events):
    ch = await service.create_channel(db, "gen", "public", "alice")
    old = await chat_router.upload_chat_file(
        channel_id=ch.id, file=_up(b"data", "보고서.pdf"), parent_id=None, also_to_channel=False,
        user=await u(db, "alice"), db=db,
    )
    assert len(old["attachments"]) == 1
    a = old["attachments"][0]
    assert a["filename"] == "보고서.pdf" and a["spoiler"] is False and a["alt"] is None
    r = await service.create_message(db, ch.id, "alice", "이거", reply_to_id=old["id"])
    assert r["reply_to"]["content"] == "" and r["reply_to"]["attachment_kind"] == "file"


@pytest.mark.asyncio
async def test_limits(db, events, monkeypatch, tmp_path):
    ch = await service.create_channel(db, "gen", "public", "alice", member_ids=["bob"])
    with pytest.raises(HTTPException) as e:
        await _attach(db, ch.id, "alice", [_up(b"x", f"{i}.txt") for i in range(11)])
    assert e.value.detail["code"] == "too_many_files"
    monkeypatch.setattr(router22, "MAX_FILE_BYTES", 10)
    with pytest.raises(HTTPException) as e:
        await _attach(db, ch.id, "alice", [_up(b"small", "ok.txt"), _up(b"x" * 50, "big.bin")])
    assert e.value.status_code == 413 and e.value.detail["code"] == "too_large"
    # 실패하면 앞서 쓴 파일도 지운다
    assert not list((tmp_path / "chat_files" / ch.id).iterdir())
    with pytest.raises(HTTPException) as e:
        await _attach(db, ch.id, "dave", [_up(b"x", "a.txt")])
    assert e.value.status_code == 403


@pytest.mark.asyncio
async def test_attachments_reply_silent_thread(db, events):
    ch = await service.create_channel(db, "gen", "public", "alice", member_ids=["bob"])
    root = await service.create_message(db, ch.id, "alice", "루트")
    msg = await _attach(db, ch.id, "bob", [_up(b"x", "a.txt")], content="@silent 첨부",
                        reply_to_id=root["id"], parent_id=root["id"])
    assert msg["silent"] is True and msg["parent_id"] == root["id"] and msg["reply_to"]["state"] == "ok"
