"""chat22 포럼 갤러리 — 게시판 글 목록 항목의 thumbnail_url(본문 첫 이미지, 없으면 null). 목록 조회는 조회수를 증가시키지 않는다."""

import pytest

from app.board import service as board_service
from app.board.service import post_thumbnail_url
from app.db.models import Post
from tests.chat22_fixtures import db, events  # noqa: F401


def test_thumbnail_extraction():
    assert post_thumbnail_url('<p>a</p><img alt="x" src="/api/files/a.png"><img src="/b.png">', None) == "/api/files/a.png"
    assert post_thumbnail_url("글 ![그림](https://ex.com/c.jpg) 끝", None) == "https://ex.com/c.jpg"
    assert post_thumbnail_url('![a](/first.png) <img src="/second.png">', None) == "/first.png"
    assert post_thumbnail_url('<img src="javascript:alert(1)"><img src="/ok.png">', None) is None   # 첫 이미지가 위험하면 썸네일 없음
    assert post_thumbnail_url('<img src="data:image/png;base64,AAA">', None) is None
    assert post_thumbnail_url('<img src="//evil.example/x.png">', None) is None
    assert post_thumbnail_url("그림 없음", [{"url": "/att.png", "mime_type": "image/png"}]) == "/att.png"
    assert post_thumbnail_url("그림 없음", [{"url": "/doc.pdf", "mime_type": "application/pdf"}]) is None
    assert post_thumbnail_url(None, None) is None


@pytest.mark.asyncio
async def test_posts_list_has_thumbnail_and_no_view_bump(db, events):
    b = await board_service.create_board(db, name="포럼", slug="forum-x")
    p1 = await board_service.create_post(db, board_id=b["id"], author_id="alice", title="사진",
                                         content='<p>보세요</p><img src="/api/board/files/p.png">')
    p2 = await board_service.create_post(db, board_id=b["id"], author_id="bob", title="글만", content="본문",
                                         attachments=[{"url": "/a.png", "mime_type": "image/png"}])
    p3 = await board_service.create_post(db, board_id=b["id"], author_id="bob", title="없음", content="본문")
    res = await board_service.get_posts(db, b["id"], user_id="carol")
    by = {x["id"]: x for x in res["posts"]}
    assert by[p1["id"]]["thumbnail_url"] == "/api/board/files/p.png"
    assert by[p2["id"]]["thumbnail_url"] == "/a.png"
    assert by[p3["id"]]["thumbnail_url"] is None
    assert all("is_read" in x for x in res["posts"])
    for pid in (p1["id"], p2["id"], p3["id"]):
        assert (await db.get(Post, pid)).view_count == 0
