"""`@` 로 시작하는 파일·폴더 이름 허용.

과거에는 "@ 로 시작하면 전부 숨김·거부"였다(NAS 시스템 폴더 대응). 현재 숨김·거부 대상은 알려진 NAS 시스템 이름
(@Recycle·@eaDir·#recycle …, 대소문자 무시)뿐이며 "@회의록" 은 일반 항목이다 — 생성·이름 변경·업로드·이동·
목록·검색·색인·공유 링크 폴더 탐색·zip·사용자 공유 하위 경로·휴지통. `.` 으로 시작하는 이름은 기존대로 거부.
숨김 판정은 fs.is_hidden_name 단일 지점에서 수행.
"""

import io
import zipfile
from types import SimpleNamespace

import pytest
from fastapi import HTTPException, UploadFile

from app.files import access as acc
from app.files import indexer
from app.files import router as fr
from app.files import service as fs
from app.files.schemas import MkdirRequest, MoveRequest, RenameRequest, ShareLinkCreate
from tests.test_files_p4 import Req, env  # noqa: F401 (픽스처 재사용)

NAS = ["@Recycle", "@recycle", "@RECYCLE", "@Recently-Snapshot", "@eaDir", "@__thumb", "@tmp", "@SynoResource",
       "#recycle", "#snapshot", "#Recycle"]
USER = ["@회의록", "@프로젝트", "@", "@@", "@Recycle2", "@Recycle.txt", "#기술부 업무관리", "#recycled", "a@b", "@eaDir 백업"]


@pytest.mark.parametrize("name", NAS)
def test_nas_system_names_hidden_and_refused(name):
    assert fs.is_system_name(name) and fs.is_hidden_name(name) and fs._is_hidden(name)
    with pytest.raises(fs.InvalidNameError) as e:
        fs.validate_name(name)
    assert "저장 장치" in str(e.value)


@pytest.mark.parametrize("name", USER)
def test_user_at_names_are_ordinary(name):
    assert not fs.is_hidden_name(name)
    assert fs.validate_name(f" {name} ") == name


@pytest.mark.parametrize("name", [".env", ".@__thumb", ".회의록", ".", ".."])
def test_dot_names_still_refused(name):
    assert fs.is_hidden_name(name)
    with pytest.raises(fs.InvalidNameError) as e:
        fs.validate_name(name)
    assert "@" not in str(e.value)          # 안내 문구가 더 이상 @ 를 원인으로 지목하지 않는다


async def _status(coro) -> int:
    with pytest.raises(HTTPException) as e:
        await coro
    return e.value.status_code


@pytest.mark.asyncio
async def test_create_rename_upload_move_trash_with_at_names(env):
    db, alice = env.db, env.alice
    # 새 폴더
    await fr.mkdir(body=MkdirRequest(path="my/docs/@회의록"), user=alice, db=db)
    assert (env.home / "docs" / "@회의록").is_dir()
    # 이름 변경
    r = await fr.rename_file(body=RenameRequest(path="my/docs/a.txt", new_name="@메모.txt"), user=alice, db=db)
    assert r["new_name"] == "@메모.txt" and (env.home / "docs" / "@메모.txt").read_text() == "hello"
    # 업로드
    up = UploadFile(filename="@올림.txt", file=io.BytesIO(b"up"))
    r = await fr.upload_file(up, path="my/docs/@회의록", upload_id=None, size=2, mtime=None, x_file_mtime=None,
                             user=alice, db=db)
    assert r["name"] == "@올림.txt" and (env.home / "docs" / "@회의록" / "@올림.txt").read_bytes() == b"up"
    # 이동(@ 폴더 내부로) · 복사
    r = await fr.move_file(body=MoveRequest(src="my/docs/@메모.txt", dst="my/docs/@회의록", copy=False), user=alice, db=db)
    assert r["path"] == "my/docs/@회의록/@메모.txt"
    r = await fr.move_file(body=MoveRequest(src="my/docs/@회의록", dst="my", copy=True), user=alice, db=db)
    assert (env.home / "@회의록" / "@메모.txt").is_file()
    # 목록에 표시됨
    names = [i.name for i in fs._scan_directory(env.home / "docs", "my/docs")]
    assert "@회의록" in names
    listed = await fr.list_files(path="my/docs/@회의록", user=alice, db=db)
    assert sorted(i.name for i in listed.items) == ["@메모.txt", "@올림.txt"]
    # 휴지통으로 이동한 뒤 목록에서 원래 이름으로 표시됨
    await fr.delete_file(path="my/docs/@회의록/@올림.txt", permanent=False, user=alice, db=db)
    assert not (env.home / "docs" / "@회의록" / "@올림.txt").exists()
    trash = await fr.list_trash(user=alice, db=db)
    assert [t.name for t in trash.items] == ["@올림.txt"]
    # NAS 이름·점 이름은 기존대로 400
    for bad in ("@Recycle", "@eadir", "#recycle", ".숨김"):
        assert await _status(fr.mkdir(body=MkdirRequest(path=f"my/docs/{bad}"), user=alice, db=db)) == 400
        assert await _status(fr.rename_file(body=RenameRequest(path="my/docs/sub", new_name=bad), user=alice, db=db)) == 400
        bad_up = UploadFile(filename=bad, file=io.BytesIO(b"x"))
        assert await _status(fr.upload_file(bad_up, path="my/docs", upload_id=None, size=1, mtime=None,
                                            x_file_mtime=None, user=alice, db=db)) == 400


def _tree(home):
    """@회의록(사용자) + @Recycle·@eaDir·#recycle(NAS) + .secret 이 혼재하는 폴더."""
    d = home / "docs"
    (d / "@회의록").mkdir()
    (d / "@회의록" / "1월.txt").write_text("회의")
    (d / "@공지.txt").write_text("공지")
    for nas in ("@Recycle", "@eaDir", "#recycle"):
        (d / nas).mkdir()
        (d / nas / "지운것.txt").write_text("z")
    (d / "sub" / "@eaDir").mkdir()
    (d / "sub" / "@eaDir" / "thumb.txt").write_text("t")
    (d / ".secret").write_text("x")


def test_listing_and_name_search_hide_only_nas_names(env):
    _tree(env.home)
    names = [i.name for i in fs._scan_directory(env.home / "docs", "my/docs")]
    assert names == ["@회의록", "sub", "@공지.txt", "a.txt"]
    hits = {i.path for i in fs.search_directory(env.home / "docs", "my/docs", "txt")}
    assert hits == {"my/docs/@공지.txt", "my/docs/@회의록/1월.txt", "my/docs/a.txt", "my/docs/sub/b.txt"}
    assert [i.name for i in fs.search_directory(env.home / "docs", "my/docs", "회의록")] == ["@회의록"]


def test_indexer_indexes_at_names_and_skips_nas_folders(env, monkeypatch):
    _tree(env.home)
    monkeypatch.setattr(indexer, "STORAGE_ROOT", env.root)
    rows, alive = indexer._scan_scope(env.home, "alice", {})
    assert {"docs/@회의록", "docs/@회의록/1월.txt", "docs/@공지.txt", "docs/a.txt"} <= alive
    # 과거에는 "." 만 제외하여 NAS 휴지통 내 파일까지 색인(검색 노출)되었다
    assert not any("@Recycle" in r or "@eaDir" in r or "#recycle" in r or ".secret" in r for r in alive)
    assert {r["rel_path"] for r in rows} == alive
    quick = {r["rel_path"] for r in indexer._quick_rows(env.home / "docs")}
    assert "docs/@회의록/1월.txt" in quick and "docs/@공지.txt" in quick
    assert not any("@Recycle" in r or "@eaDir" in r or "#recycle" in r for r in quick)
    assert indexer._quick_rows(env.home / "docs" / "@Recycle" / "지운것.txt") == []
    assert [r["rel_path"] for r in indexer._quick_rows(env.home / "docs" / "@공지.txt")] == ["docs/@공지.txt"]


@pytest.mark.asyncio
async def test_folder_link_browse_download_and_zip(env):
    _tree(env.home)
    link = await fr.create_share_link(body=ShareLinkCreate(paths=["my/docs"]), user=env.alice, db=env.db)
    top = await fr.list_shared_link_folder(token=link.token, request=Req(), sub="", access=None, db=env.db)
    assert [i["name"] for i in top["items"]] == ["@회의록", "sub", "@공지.txt", "a.txt"]
    inner = await fr.list_shared_link_folder(token=link.token, request=Req(), sub="@회의록", access=None, db=env.db)
    assert [i["path"] for i in inner["items"]] == ["@회의록/1월.txt"]
    resp = await fr.download_shared(token=link.token, request=Req(), access=None, inline=False, sub="@회의록/1월.txt", db=env.db)
    assert resp.status_code == 200
    for bad in ("@Recycle", "@Recycle/지운것.txt", "@recycle/지운것.txt", "sub/@eaDir/thumb.txt", "#recycle", ".secret"):
        with pytest.raises(HTTPException) as e:
            await fr.list_shared_link_folder(token=link.token, request=Req(), sub=bad, access=None, db=env.db)
        assert e.value.status_code == 404, bad
        with pytest.raises(HTTPException) as e:
            await fr.download_shared(token=link.token, request=Req(), access=None, inline=False, sub=bad, db=env.db)
        assert e.value.status_code == 404, bad
    resp = await fr.download_shared(token=link.token, request=Req(), access=None, inline=False, db=env.db)
    names = zipfile.ZipFile(io.BytesIO(b"".join([c async for c in resp.body_iterator]))).namelist()
    assert sorted(names) == sorted(["docs/@공지.txt", "docs/@회의록/1월.txt", "docs/a.txt", "docs/sub/b.txt"])
    # @ 이름 자체로도 링크 생성 가능(파일·폴더)
    one = await fr.create_share_link(body=ShareLinkCreate(path="my/docs/@공지.txt"), user=env.alice, db=env.db)
    resp = await fr.download_shared(token=one.token, request=Req(), access=None, inline=False, db=env.db)
    assert resp.status_code == 200
    fl = await fr.create_share_link(body=ShareLinkCreate(paths=["my/docs/@회의록"]), user=env.alice, db=env.db)
    assert fl.is_folder


def test_user_share_subpath_allows_at_names(env):
    _tree(env.home)
    share = SimpleNamespace(owner_id="alice", file_path="my/docs")
    assert acc.shared_sub_real(share, "@회의록/1월.txt") == (env.home / "docs" / "@회의록" / "1월.txt").resolve()
    for bad in ("@Recycle/지운것.txt", "sub/@eaDir/thumb.txt", "#recycle", ".secret"):
        with pytest.raises(HTTPException) as e:
            acc.shared_sub_real(share, bad)
        assert e.value.status_code == 404, bad
