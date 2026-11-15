"""회귀 — Git API 가 관리자 권한으로 사용자 요청을 대신하지 않는다.

- 연결된 계정: 모든 Gitea 호출에 그 사용자 Sudo 가 붙는다(비공개 리포 권한은 Gitea 가 판정)
- 계정 없는 사용자: 공개 리포 읽기만, 쓰기(머지·이슈·리뷰·스타)는 403, 비공개 리포는 404
- 공용 최근 커밋 캐시는 사용자가 볼 수 있는 리포만 내보낸다
"""

import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.auth.deps import get_current_user
from app.git import gitea
from app.git import router as git_router
from app.git.schemas import RecentCommit

MEMBER = SimpleNamespace(id="u1", username="minji", is_admin=False)
NOACCT = SimpleNamespace(id="u2", username="guest", is_admin=False)

PUBLIC = {"full_name": "pub/site", "name": "site", "private": False, "owner": {"login": "pub", "visibility": "public"}}
PRIVATE = {"full_name": "corp/secret", "name": "secret", "private": True, "owner": {"login": "corp", "visibility": "private"}}


@pytest.fixture()
def gitea_mock(monkeypatch):
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path.replace("/api/v1", "")
        sudo = req.headers.get("Sudo")
        calls.append((req.method, path, sudo, dict(req.url.params)))
        if path == "/user":
            return httpx.Response(200 if sudo == "minji" else 404, json={"login": sudo})
        if path == "/repos/corp/secret":
            # Gitea 쪽 권한 판정 흉내: 관리자(무 Sudo)만 보인다
            return httpx.Response(200 if sudo is None else 404, json=PRIVATE)
        if path == "/repos/pub/site":
            return httpx.Response(200, json=PUBLIC)
        if path == "/repos/search":
            if req.url.params.get("is_private") == "false":
                data = [PUBLIC]
            elif sudo == "minji":
                data = [PUBLIC]
            else:
                data = [PUBLIC, PRIVATE]
            return httpx.Response(200, json={"data": data}, headers={"x-total-count": str(len(data))})
        if path.endswith("/merge"):
            return httpx.Response(200, json={})
        if path.endswith("/contents/README.md"):
            return httpx.Response(200, json={"name": "README.md", "path": "README.md", "size": 2,
                                             "content": "aGk=", "encoding": "base64"})
        return httpx.Response(404, json={})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), base_url="http://gitea/api/v1",
                               headers={"Authorization": "token admin"})
    monkeypatch.setattr(gitea, "_get_client", lambda: client)
    git_router._account_cache.clear()

    async def cached():
        return [
            RecentCommit(repo_full_name="pub/site", repo_name="site", sha="1", message="m",
                         author_name="a", author_date="2026-10-01", branch="main"),
            RecentCommit(repo_full_name="corp/secret", repo_name="secret", sha="2", message="secret",
                         author_name="b", author_date="2026-10-02", branch="main"),
        ]
    monkeypatch.setattr(git_router, "_cached_recent_commits", cached)
    return calls


def _app(user):
    app = FastAPI()
    app.include_router(git_router.router)
    app.dependency_overrides[get_current_user] = lambda: user
    return app


async def _req(user, method, url, **kw):
    async with AsyncClient(transport=ASGITransport(app=_app(user)), base_url="http://t") as c:
        return await c.request(method, url, **kw)


def test_every_git_route_has_identity_dependency():
    for r in git_router.router.routes:
        deps = [d.call for d in r.dependant.dependencies]
        assert git_router.git_identity in deps, r.path


@pytest.mark.asyncio
async def test_member_calls_go_out_with_own_sudo(gitea_mock):
    r = await _req(MEMBER, "POST", "/api/git/repos/corp/secret/pulls/1/merge", json={"merge_style": "merge"})
    # 머지 호출에는 반드시 그 사용자 Sudo 가 붙는다(관리자 권한으로 머지하지 않음)
    merges = [c for c in gitea_mock if c[1].endswith("/merge")]
    assert merges and all(c[2] == "minji" for c in merges)
    r = await _req(MEMBER, "GET", "/api/git/repos/corp/secret")
    assert r.status_code == 404  # Gitea 가 그 사용자 권한으로 거절
    user_calls = [c for c in gitea_mock if c[1].startswith("/repos/corp/secret")]
    assert all(c[2] == "minji" for c in user_calls)


@pytest.mark.asyncio
async def test_no_account_user_read_public_only(gitea_mock):
    r = await _req(NOACCT, "GET", "/api/git/repos")
    assert r.status_code == 200
    names = [x["full_name"] for x in r.json()["repos"]]
    assert names == ["pub/site"]
    r = await _req(NOACCT, "GET", "/api/git/repos/corp/secret")
    assert r.status_code == 404
    r = await _req(NOACCT, "GET", "/api/git/repos/corp/secret/file", params={"path": "README.md"})
    assert r.status_code == 404
    r = await _req(NOACCT, "GET", "/api/git/repos/pub/site/file", params={"path": "README.md"})
    assert r.status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize("method,url,body", [
    ("POST", "/api/git/repos/pub/site/pulls/1/merge", {"merge_style": "merge"}),
    ("POST", "/api/git/repos/pub/site/issues", {"title": "x"}),
    ("PATCH", "/api/git/repos/pub/site/issues/1", {"state": "closed"}),
    ("POST", "/api/git/repos/pub/site/pulls/1/reviews", {"body": "x"}),
    ("PUT", "/api/git/repos/pub/site/star", None),
])
async def test_no_account_user_cannot_write(gitea_mock, method, url, body):
    r = await _req(NOACCT, method, url, json=body)
    assert r.status_code == 403
    assert not any(c[0] != "GET" for c in gitea_mock)


@pytest.mark.asyncio
async def test_recent_commits_filtered_per_user(gitea_mock):
    r = await _req(NOACCT, "GET", "/api/git/recent-commits")
    assert [c["repo_full_name"] for c in r.json()] == ["pub/site"]
    r = await _req(MEMBER, "GET", "/api/git/recent-commits")
    assert "corp/secret" not in [c["repo_full_name"] for c in r.json()]


@pytest.mark.asyncio
async def test_path_traversal_segments_rejected(gitea_mock):
    r = await _req(MEMBER, "GET", "/api/git/repos/pub/site/file", params={"path": "../../admin/users"})
    assert r.status_code == 404
    assert not any("admin" in c[1] for c in gitea_mock)
