"""폴더 공유 링크 탐색(OneDrive식 보기 전용).

- 폴더 하나로 생성한 링크는 손님 화면 주소(/s/<token>)를 반환하며, 내부를 탐색하면서 파일별로 내려받는다.
- 범위는 링크 폴더 하위로 제한: `..`·숨김(./@)·심볼릭 탈출은 목록에서 제외되고 요청은 404.
- 비밀번호·내려받기 차단·횟수 제한은 그대로 적용된다. 미리보기는 횟수에 집계하지 않는다.
"""

import io
import os
import zipfile

import pytest
from fastapi import HTTPException

from app.db.models import ShareLink
from app.files import router as fr
from app.files import share_email as se
from app.files.schemas import ShareLinkCreate, ShareUnlockRequest
from tests.test_files_p4 import Req, env  # noqa: F401 (픽스처 재사용)


async def _folder(env, **kw):
    (env.home / "docs" / ".secret").write_text("x")
    (env.home / "docs" / "@Recycle").mkdir()
    (env.home / "docs" / "@Recycle" / "z.txt").write_text("z")
    return await fr.create_share_link(body=ShareLinkCreate(paths=["my/docs"], **kw), user=env.alice, db=env.db)


async def _count(env, link_id):
    row = await env.db.get(ShareLink, link_id)
    await env.db.refresh(row)
    return row.download_count


@pytest.mark.asyncio
async def test_folder_link_url_and_flags(env):
    from app.wopi import share as wshare
    link = await _folder(env)
    assert link.is_folder and link.url.endswith(f"/s/{link.token}")
    single = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt"), user=env.alice, db=env.db)
    assert not single.is_folder and "/api/files/shared/" in single.url
    multi = await fr.create_share_link(body=ShareLinkCreate(paths=["my/docs", "my/img.png"]), user=env.alice, db=env.db)
    assert not multi.is_folder
    info = await wshare.shared_info(token=link.token, db=env.db)
    assert info.is_folder and info.is_multi
    lst = {l.token: l for l in await fr.list_share_links(user=env.alice, db=env.db)}
    assert lst[link.token].is_folder and not lst[multi.token].is_folder
    row = await env.db.get(ShareLink, link.id)
    assert se.link_url(row).endswith(f"/s/{link.token}")


@pytest.mark.asyncio
async def test_list_hides_and_navigates(env):
    link = await _folder(env)
    top = await fr.list_shared_link_folder(token=link.token, request=Req(), sub="", access=None, db=env.db)
    assert top["name"] == "docs"
    assert [(i["name"], i["is_dir"]) for i in top["items"]] == [("sub", True), ("a.txt", False)]
    assert top["items"][1]["preview"] == "text" and top["items"][1]["size"] == 5
    sub = await fr.list_shared_link_folder(token=link.token, request=Req(), sub="sub", access=None, db=env.db)
    assert [i["path"] for i in sub["items"]] == ["sub/b.txt"]
    assert await _count(env, link.id) == 0          # 탐색은 횟수에 집계하지 않음


@pytest.mark.asyncio
@pytest.mark.parametrize("bad", ["..", "../img.png", "sub/../../img.png", ".secret", "@Recycle/z.txt", "없음", "a.txt/x"])
async def test_escape_and_hidden_are_404(env, bad):
    link = await _folder(env)
    with pytest.raises(HTTPException) as e:
        await fr.download_shared(token=link.token, request=Req(), access=None, inline=False, sub=bad, db=env.db)
    assert e.value.status_code == 404
    with pytest.raises(HTTPException) as e:
        await fr.list_shared_link_folder(token=link.token, request=Req(), sub=bad, access=None, db=env.db)
    assert e.value.status_code == 404


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="심볼릭 링크 권한")
async def test_symlink_escape_hidden(env):
    os.symlink(env.home / "img.png", env.home / "docs" / "out.png")
    os.symlink(env.home, env.home / "docs" / "homelink")
    link = await _folder(env)
    top = await fr.list_shared_link_folder(token=link.token, request=Req(), sub="", access=None, db=env.db)
    assert {i["name"] for i in top["items"]} == {"sub", "a.txt"}
    for bad in ("out.png", "homelink/img.png"):
        with pytest.raises(HTTPException):
            await fr.download_shared(token=link.token, request=Req(), access=None, inline=False, sub=bad, db=env.db)
    resp = await fr.download_shared(token=link.token, request=Req(), access=None, inline=False, db=env.db)
    names = zipfile.ZipFile(io.BytesIO(b"".join([c async for c in resp.body_iterator]))).namelist()
    assert sorted(names) == ["docs/a.txt", "docs/sub/b.txt"]


@pytest.mark.asyncio
async def test_download_file_subfolder_zip_and_whole(env):
    link = await _folder(env)
    resp = await fr.download_shared(token=link.token, request=Req(), access=None, inline=False, sub="sub/b.txt", db=env.db)
    assert resp.status_code == 200 and "b.txt" in resp.headers["content-disposition"]
    resp = await fr.download_shared(token=link.token, request=Req(), access=None, inline=False, sub="sub", db=env.db)
    z = zipfile.ZipFile(io.BytesIO(b"".join([c async for c in resp.body_iterator])))
    assert z.namelist() == ["sub/b.txt"] and "sub.zip" in resp.headers["content-disposition"]
    resp = await fr.download_shared(token=link.token, request=Req(), access=None, inline=False, db=env.db)
    z = zipfile.ZipFile(io.BytesIO(b"".join([c async for c in resp.body_iterator])))
    assert sorted(z.namelist()) == ["docs/a.txt", "docs/sub/b.txt"]     # 숨김(./@)은 zip 에도 미포함
    assert await _count(env, link.id) == 3


@pytest.mark.asyncio
async def test_preview_does_not_count_and_one_time(env):
    link = await _folder(env, one_time=True)
    await fr.download_shared(token=link.token, request=Req(), access=None, inline=True, sub="a.txt", db=env.db)
    assert await _count(env, link.id) == 0
    await fr.download_shared(token=link.token, request=Req(), access=None, inline=False, sub="a.txt", db=env.db)
    with pytest.raises(HTTPException) as e:
        await fr.download_shared(token=link.token, request=Req(), access=None, inline=False, sub="sub/b.txt", db=env.db)
    assert e.value.status_code == 410
    with pytest.raises(HTTPException) as e:
        await fr.list_shared_link_folder(token=link.token, request=Req(), sub="", access=None, db=env.db)
    assert e.value.status_code == 410


@pytest.mark.asyncio
async def test_blocked_folder_preview_only(env):
    link = await _folder(env, allow_download=False)
    top = await fr.list_shared_link_folder(token=link.token, request=Req(), sub="", access=None, db=env.db)
    assert top["allow_download"] is False
    res = await fr.download_shared(token=link.token, request=Req(), access=None, inline=True, sub="sub/b.txt", db=env.db)
    assert res["type"] == "text" and "world" in res["content"] and res["name"] == "b.txt"
    for kw in ({"sub": "a.txt", "inline": False}, {"sub": "sub", "inline": True}, {"sub": None, "inline": False}):
        with pytest.raises(HTTPException) as e:
            await fr.download_shared(token=link.token, request=Req(), access=None, db=env.db, **kw)
        assert e.value.status_code == 403


@pytest.mark.asyncio
async def test_password_folder(env):
    link = await _folder(env, password="1234")
    with pytest.raises(HTTPException) as e:
        await fr.list_shared_link_folder(token=link.token, request=Req(), sub="", access=None, db=env.db)
    assert e.value.status_code == 401
    acc = (await fr.unlock_shared(token=link.token, body=ShareUnlockRequest(password="1234"), db=env.db))["access"]
    top = await fr.list_shared_link_folder(token=link.token, request=Req(), sub="", access=acc, db=env.db)
    assert len(top["items"]) == 2


@pytest.mark.asyncio
async def test_sub_rejected_on_non_folder_links(env):
    single = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/a.txt"), user=env.alice, db=env.db)
    multi = await fr.create_share_link(body=ShareLinkCreate(paths=["my/docs", "my/img.png"]), user=env.alice, db=env.db)
    for tok in (single.token, multi.token):
        with pytest.raises(HTTPException) as e:
            await fr.download_shared(token=tok, request=Req(), access=None, inline=False, sub="sub/b.txt", db=env.db)
        assert e.value.status_code == 400
        with pytest.raises(HTTPException) as e:
            await fr.list_shared_link_folder(token=tok, request=Req(), sub="", access=None, db=env.db)
        assert e.value.status_code == 400
