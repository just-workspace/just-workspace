"""파일 구역 잔여(독립 검토) — 묶음 링크 + 내려받기 차단 거부, path/paths 혼용, 삭제된 원본의 unlock 안내,
숨김 판정 통합에서 누락되었던 지점(AI 폴더 묶기·zip 풀기·통합 검색)."""

import zipfile

import pytest
from fastapi import HTTPException

from app.db.models import ShareLink
from app.files import router as fr
from app.files.schemas import ShareLinkCreate, ShareLinkUpdate, ShareUnlockRequest
from tests.test_files_p4 import Req, env  # noqa: F401 (픽스처 재사용)


async def _err(coro):
    with pytest.raises(HTTPException) as e:
        await coro
    return e.value


def _mk(env, **kw):
    return fr.create_share_link(body=ShareLinkCreate(**kw), user=env.alice, db=env.db)


@pytest.mark.asyncio
async def test_bundle_with_block_is_refused_on_create(env):
    (env.home / "docs" / "app.zip").write_bytes(b"x")
    for kw in (
        {"paths": ["my/docs/a.txt", "my/img.png"]},                 # 2개 이상
        {"paths": ["my/docs", "my/img.png"]},                       # 폴더 + 파일
        {"path": "my/docs/a.txt", "paths": ["my/img.png"]},         # path + paths 혼용 = 묶음
        {"path": "my/img.png", "paths": ["my/docs"]},
    ):
        e = await _err(_mk(env, allow_download=False, **kw))
        assert e.status_code == 400 and e.detail == fr.BUNDLE_BLOCK_DETAIL, kw
        assert (await _mk(env, **kw)).item_count == 2               # 내려받기 허용이면 생성 가능
    # 혼용이 동일 파일 하나를 가리키면 단일 파일 규칙 적용(미리보기 가능 여부)
    e = await _err(_mk(env, path="my/docs/app.zip", paths=["my/docs/app.zip"], allow_download=False))
    assert e.status_code == 400 and e.detail == fr.NO_PREVIEW_BLOCK_DETAIL
    one = await _mk(env, path="my/docs/a.txt", paths=["my/docs/a.txt"], allow_download=False)
    row = await env.db.get(ShareLink, one.id)
    assert row.paths is None and row.file_path == "my/docs/a.txt" and one.item_count == 1
    # 폴더 하나(둘러보기)는 그대로 허용 — path 로 폴더를 전달해도 동일
    assert (await _mk(env, paths=["my/docs"], allow_download=False)).is_folder


@pytest.mark.asyncio
async def test_bundle_patch_refused_but_old_links_kept(env):
    db = env.db
    b = await _mk(env, paths=["my/docs/a.txt", "my/img.png"])
    lst = {l.id: l for l in await fr.list_share_links(user=env.alice, db=db)}
    assert lst[b.id].can_block_download is False
    e = await _err(fr.update_share_link(link_id=b.id, body=ShareLinkUpdate(allow_download=False), user=env.alice, db=db))
    assert e.status_code == 400 and e.detail == fr.BUNDLE_BLOCK_DETAIL
    # 과거 paths 로 생성된 "파일 하나짜리 묶음"도 동일
    row = await db.get(ShareLink, b.id)
    row.paths = '["my/docs/a.txt"]'
    await db.commit()
    e = await _err(fr.update_share_link(link_id=b.id, body=ShareLinkUpdate(allow_download=False), user=env.alice, db=db))
    assert e.status_code == 400
    # 이미 차단 상태였던 구 묶음 링크는 다른 설정 수정 가능
    row.allow_download = False
    await db.commit()
    item = await fr.update_share_link(link_id=b.id, body=ShareLinkUpdate(allow_download=False, max_downloads=2),
                                      user=env.alice, db=db)
    assert item.allow_download is False and item.max_downloads == 2
    # 폴더 링크는 내려받기 차단으로 변경 가능
    f = await _mk(env, paths=["my/docs"])
    item = await fr.update_share_link(link_id=f.id, body=ShareLinkUpdate(allow_download=False), user=env.alice, db=db)
    assert item.allow_download is False and item.can_block_download is True


@pytest.mark.asyncio
async def test_unlock_reports_missing_original_before_preview(env):
    db = env.db
    link = await _mk(env, path="my/docs/a.txt", allow_download=False, password="1234")
    r = await fr.unlock_shared(token=link.token, body=ShareUnlockRequest(password="1234"), db=db)
    assert r["exists"] is True and r["can_preview"] is True
    (env.home / "docs" / "a.txt").unlink()
    r = await fr.unlock_shared(token=link.token, body=ShareUnlockRequest(password="1234"), db=db)
    assert r["exists"] is False and r["can_preview"] is True      # 존재하지 않는 파일을 "미리 볼 수 없는 형식"으로 안내하지 않는다
    # 폴더 링크·묶음도 원본 존재 여부를 반환한다
    f = await _mk(env, paths=["my/docs/sub"], password="1234")
    assert (await fr.unlock_shared(token=f.token, body=ShareUnlockRequest(password="1234"), db=db))["exists"] is True
    (env.home / "docs" / "sub" / "b.txt").unlink()
    (env.home / "docs" / "sub").rmdir()
    assert (await fr.unlock_shared(token=f.token, body=ShareUnlockRequest(password="1234"), db=db))["exists"] is False


def test_unzip_plan_skips_nas_system_entries(tmp_path):
    from app.mcp.tools import archive_tool as at
    z = tmp_path / "a.zip"
    with zipfile.ZipFile(z, "w") as zf:
        zf.writestr("@회의록/1월.txt", "ok")
        zf.writestr("@Recycle/지운것.txt", "z")
        zf.writestr("docs/@eaDir/thumb.jpg", "t")
        zf.writestr(".hidden/x.txt", "h")
        zf.writestr("b.txt", "b")
    plan, skipped, _total = at._plan(z, 1000, 10**9)
    assert sorted("/".join(parts) for _i, parts in plan) == ["@회의록/1월.txt", "b.txt"]
    assert sorted(s["name"] for s in skipped) == ["@Recycle/지운것.txt", "docs/@eaDir/thumb.jpg"]
    assert all("저장 장치" in s["reason"] for s in skipped)


def test_artifact_dst_path_rules():
    from app.ai import artifacts as ar
    assert ar._dst_vp("my/@회의록/자료", "x.zip") == "my/@회의록/자료.zip"
    for bad in ("my/@Recycle/자료.zip", "my/a/@eaDir/b.zip", "my/.숨김/b.zip"):
        with pytest.raises(ar.ArtifactError):
            ar._dst_vp(bad, "x.zip")


def test_all_callers_use_one_hidden_rule():
    """판정 로직의 재분산 방지 — 해당 모듈들이 files.service 의 함수를 사용한다."""
    from app.ai import artifacts as ar
    from app.files import service as fs
    from app.search import router as sr
    assert ar._files_hidden is fs.is_hidden_name and sr._files_hidden is fs.is_hidden_name
