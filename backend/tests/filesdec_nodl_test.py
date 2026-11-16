""""내려받기 막음(미리보기만)" 링크와 미리보기 불가 형식.

- 파일 하나짜리 링크: 미리보기 불가 형식이면 생성·변경 시 400(이유 문구) — 수신자가 아무것도 볼 수 없는 열람 불가 링크.
- 판정은 손님 화면과 동일한 함수(fr._preview_kind): 텍스트·이미지·PDF 만 허용(svg·html·오피스·zip 은 불가).
- 폴더 링크는 허용(내부의 미리보기 불가 파일은 목록에 preview=None → 손님 화면이 안내).
- 과거에 생성된 열람 불가 링크는 그대로 유지한다 — info.can_preview=False / unlock 의 can_preview 로 손님 화면이 안내만 수행한다.
"""

import pytest
from fastapi import HTTPException

from app.db.models import ShareLink
from app.files import router as fr
from app.files.schemas import ShareLinkCreate, ShareLinkUpdate, ShareUnlockRequest
from tests.test_files_p4 import Req, env  # noqa: F401 (픽스처 재사용)

PNG = b"\x89PNG\r\n\x1a\n"
OK = {"a.txt": "text", "pic.png": "image", "doc.pdf": "pdf", "note.md": "text", "data.JSON": "text"}
NO = ["app.zip", "r.docx", "sheet.xlsx", "movie.mp4", "pic.svg", "page.html", "noext", "bin.exe"]


def _files(env):
    d = env.home / "docs"
    for n in list(OK) + NO:
        if not (d / n).exists():
            (d / n).write_bytes(PNG if n.endswith(".png") else b"%PDF-1.4" if n.endswith(".pdf") else b"x")
    return d


async def _err(coro):
    with pytest.raises(HTTPException) as e:
        await coro
    return e.value


def test_preview_kind_matrix(env):
    d = _files(env)
    for n, kind in OK.items():
        assert fr._preview_kind(d / n) == kind, n
    for n in NO:
        # svg·html 은 can_preview 가 image/text 로 판정해도 손님 화면에서는 열지 않는다(브라우저 내 실행 위험) / html 은 텍스트로 표시된다
        if n == "page.html":
            continue
        assert fr._preview_kind(d / n) is None, n


@pytest.mark.asyncio
@pytest.mark.parametrize("name", [n for n in NO if n != "page.html"])
async def test_create_refuses_block_on_unpreviewable_single_file(env, name):
    _files(env)
    e = await _err(fr.create_share_link(body=ShareLinkCreate(path=f"my/docs/{name}", allow_download=False),
                                        user=env.alice, db=env.db))
    assert e.status_code == 400 and e.detail == fr.NO_PREVIEW_BLOCK_DETAIL and "미리 볼 수 없" in e.detail
    # paths 에 파일 하나만 전달해도(프런트 묶음 경로) 동일 판정
    e = await _err(fr.create_share_link(body=ShareLinkCreate(paths=[f"my/docs/{name}"], allow_download=False),
                                        user=env.alice, db=env.db))
    assert e.status_code == 400
    assert (await fr.list_share_links(user=env.alice, db=env.db)) == []      # 생성된 항목 없음
    # 내려받기 허용이면 그대로 생성한다
    ok = await fr.create_share_link(body=ShareLinkCreate(path=f"my/docs/{name}"), user=env.alice, db=env.db)
    assert ok.allow_download is True


@pytest.mark.asyncio
@pytest.mark.parametrize("name", list(OK))
async def test_create_allows_block_on_previewable(env, name):
    _files(env)
    link = await fr.create_share_link(body=ShareLinkCreate(path=f"my/docs/{name}", allow_download=False),
                                      user=env.alice, db=env.db)
    assert link.allow_download is False
    # 손님이 실제로 열람 가능(동일 판정)
    res = await fr.download_shared(token=link.token, request=Req(), access=None, inline=True, db=env.db)
    assert res is not None


@pytest.mark.asyncio
async def test_edit_link_and_folder_link_unaffected(env):
    _files(env)
    # 공동 편집 링크는 편집기로 열린다 — 내려받기 값과 무관
    edit = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/r.docx", can_edit=True, allow_download=False),
                                      user=env.alice, db=env.db)
    assert edit.token
    # 폴더 링크는 허용 — 내부의 미리보기 불가 파일은 preview=None, 열람 시 403(이유 문구)
    folder = await fr.create_share_link(body=ShareLinkCreate(paths=["my/docs"], allow_download=False),
                                        user=env.alice, db=env.db)
    assert folder.is_folder and folder.allow_download is False
    top = await fr.list_shared_link_folder(token=folder.token, request=Req(), sub="", access=None, db=env.db)
    by = {i["name"]: i["preview"] for i in top["items"]}
    assert by["app.zip"] is None and by["r.docx"] is None and by["a.txt"] == "text" and by["pic.png"] == "image"
    e = await _err(fr.download_shared(token=folder.token, request=Req(), access=None, inline=True, sub="app.zip", db=env.db))
    assert e.status_code == 403 and "미리 볼 수 없" in e.detail and "내려받기가 막혀" in e.detail
    # 묶음(2개 이상)은 미리보기가 없어 거부 — filesdec_followup_test.py


@pytest.mark.asyncio
async def test_patch_refuses_turning_block_on_but_keeps_old_dead_links(env):
    _files(env)
    db = env.db
    link = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/app.zip"), user=env.alice, db=db)
    lst = {l.id: l for l in await fr.list_share_links(user=env.alice, db=db)}
    assert lst[link.id].can_block_download is False
    e = await _err(fr.update_share_link(link_id=link.id, body=ShareLinkUpdate(allow_download=False, max_downloads=3),
                                        user=env.alice, db=db))
    assert e.status_code == 400 and e.detail == fr.NO_PREVIEW_BLOCK_DETAIL
    row = await db.get(ShareLink, link.id)
    await db.refresh(row)
    assert row.allow_download is not False and row.max_downloads is None      # 함께 전달한 다른 값도 변경되지 않는다
    # 미리보기 가능 파일은 변경 가능
    txt = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt"), user=env.alice, db=db)
    item = await fr.update_share_link(link_id=txt.id, body=ShareLinkUpdate(allow_download=False), user=env.alice, db=db)
    assert item.allow_download is False and item.can_block_download is True

    # 과거에 생성된 열람 불가 링크(직접 갱신): 수정하지 않는다 — 다른 설정은 수정 가능하며, 동일 값을 재전송해도 허용된다
    row.allow_download = False
    await db.commit()
    item = await fr.update_share_link(link_id=link.id, body=ShareLinkUpdate(allow_download=False, password="pw"),
                                      user=env.alice, db=db)
    assert item.allow_download is False and item.has_password
    item = await fr.update_share_link(link_id=link.id, body=ShareLinkUpdate(allow_download=True, password=""),
                                      user=env.alice, db=db)       # 허용으로의 복원은 항상 가능
    assert item.allow_download is True


@pytest.mark.asyncio
async def test_guest_info_and_unlock_tell_nothing_to_see(env):
    from app.wopi import share as wshare
    _files(env)
    db = env.db

    async def dead(name, **kw):
        link = await fr.create_share_link(body=ShareLinkCreate(path=f"my/docs/{name}", **kw), user=env.alice, db=db)
        (await db.get(ShareLink, link.id)).allow_download = False
        await db.commit()
        return link

    z = await dead("app.zip")
    info = await wshare.shared_info(token=z.token, db=db)
    assert info.allow_download is False and info.can_preview is False
    e = await _err(fr.download_shared(token=z.token, request=Req(), access=None, inline=True, db=db))
    assert e.status_code == 403 and "미리 볼 수 없" in e.detail
    # 미리보기 가능 파일·폴더 링크는 true
    t = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt", allow_download=False), user=env.alice, db=db)
    assert (await wshare.shared_info(token=t.token, db=db)).can_preview is True
    f = await fr.create_share_link(body=ShareLinkCreate(paths=["my/docs"], allow_download=False), user=env.alice, db=db)
    assert (await wshare.shared_info(token=f.token, db=db)).can_preview is True
    # 묶음(zip)은 미리보기 없음
    m = await fr.create_share_link(body=ShareLinkCreate(paths=["my/docs/a.txt", "my/img.png"]), user=env.alice, db=db)
    (await db.get(ShareLink, m.id)).allow_download = False       # 과거에 생성된 묶음 링크
    await db.commit()
    assert (await wshare.shared_info(token=m.token, db=db)).can_preview is False
    # 비밀번호 링크: info 는 비공개(true), 해제 후 unlock 이 반환한다
    pz = await dead("r.docx", password="1234")
    assert (await wshare.shared_info(token=pz.token, db=db)).can_preview is True
    r = await fr.unlock_shared(token=pz.token, body=ShareUnlockRequest(password="1234"), db=db)
    assert r["access"] and r["can_preview"] is False
    pt = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt", allow_download=False, password="1234"),
                                    user=env.alice, db=db)
    assert (await fr.unlock_shared(token=pt.token, body=ShareUnlockRequest(password="1234"), db=db))["can_preview"] is True


@pytest.mark.asyncio
async def test_preview_kind_endpoint(env):
    _files(env)
    assert await fr.share_preview_kind(path="my/docs/a.txt", user=env.alice) == {"preview": "text", "is_file": True}
    assert await fr.share_preview_kind(path="my/docs/pic.png", user=env.alice) == {"preview": "image", "is_file": True}
    assert await fr.share_preview_kind(path="my/docs/app.zip", user=env.alice) == {"preview": None, "is_file": True}
    assert await fr.share_preview_kind(path="my/docs", user=env.alice) == {"preview": None, "is_file": False}
