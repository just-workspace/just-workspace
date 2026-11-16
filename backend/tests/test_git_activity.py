"""대시보드 Git 활동 — /api/git/activity 범위 mine·all, 계정 미연결.

Gitea HTTP 는 httpx MockTransport 로 모사한다(경로·쿼리·Sudo 헤더를 확인).
"""

from types import SimpleNamespace

import httpx
import pytest

from app.git import gitea
from app.git import router as git_router
from app.git.schemas import RecentCommit

USER = SimpleNamespace(id="u1", username="minji", is_admin=False)


def _issue(n, title, repo="o/r", pr=None, state="open", at="2026-10-15T10:00:00Z"):
    return {"number": n, "title": title, "state": state, "pull_request": pr, "updated_at": at,
            "user": {"login": "a"}, "repository": {"full_name": repo, "name": repo.split("/")[1]}}


@pytest.fixture()
def fake(monkeypatch):
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path.replace("/api/v1", "")
        q = dict(req.url.params)
        who = req.headers.get("Sudo")
        calls.append((path, q, who))
        if path == "/user":
            return httpx.Response(200 if who == "minji" else 404, json={"login": who})
        if path == "/repos/search":
            return httpx.Response(200, json={"data": [{"full_name": "o/r"}]})
        if path == "/repos/issues/search":
            if q.get("review_requested") == "true":
                return httpx.Response(200, json=[_issue(482, "리뷰 부탁", pr={"merged": False}, at="2026-10-15T10:12:00Z")])
            if q.get("assigned") == "true":
                # 482 는 리뷰 요청과 중복 — 리뷰 요청 우선
                return httpx.Response(200, json=[_issue(91, "탭바 배지", at="2026-10-15T08:40:00Z"),
                                                 _issue(482, "리뷰 부탁", pr={"merged": False})])
            if q.get("mentioned") == "true":
                return httpx.Response(200, json=[_issue(7, "멘션", at="2026-10-14T08:00:00Z")])
            if q.get("state") == "all":
                return httpx.Response(200, json=[_issue(12, "병합됨", pr={"merged": True}, state="closed", at="2026-10-14T09:00:00Z"),
                                                 _issue(88, "닫힘", state="closed", at="2026-10-13T09:00:00Z")])
        return httpx.Response(404, json={})

    client = httpx.AsyncClient(base_url="http://gitea/api/v1", transport=httpx.MockTransport(handler))
    monkeypatch.setattr(gitea, "_get_client", lambda: client)

    async def cached():
        return [RecentCommit(repo_full_name="o/r", repo_name="r", sha="a1", author_name="도윤", author_date="2026-10-15T09:40:00Z"),
                RecentCommit(repo_full_name="o/r", repo_name="r", sha="a2", author_name="준호", author_date="2026-10-15T09:00:00Z"),
                RecentCommit(repo_full_name="secret/x", repo_name="x", sha="b1", author_name="관리자", author_date="2026-10-15T11:00:00Z")]
    monkeypatch.setattr(git_router, "_cached_recent_commits", cached)
    return SimpleNamespace(calls=calls)


@pytest.mark.asyncio
async def test_mine_merges_reasons_with_priority(fake):
    res = await git_router.git_activity(scope="mine", limit=5, user=USER)
    assert res["connected"] is True
    kinds = [(i["kind"], i["number"]) for i in res["items"]]
    assert kinds == [("review", 482), ("assigned", 91), ("mention", 7)]
    # 사용자 기준 필터는 모두 Sudo 사용, 열린 항목만 대상
    searches = [c for c in fake.calls if c[0] == "/repos/issues/search"]
    assert all(c[2] == "minji" and c[1]["state"] == "open" for c in searches)
    assert any(c[1].get("type") == "pulls" and c[1].get("review_requested") == "true" for c in searches)


@pytest.mark.asyncio
async def test_all_has_issue_states_and_visible_commit_groups(fake):
    res = await git_router.git_activity(scope="all", limit=10, user=USER)
    by = {(i["kind"], i["repo_full_name"]): i for i in res["items"]}
    assert ("pr_merged", "o/r") in by and ("issue_closed", "o/r") in by
    g = by[("commits", "o/r")]
    assert g["count"] == 2 and g["authors"] == ["도윤", "준호"] and g["at"] == "2026-10-15T09:40:00Z"
    # 열람 불가 저장소(관리자 캐시에만 존재)의 커밋은 제외
    assert not any(i["repo_full_name"] == "secret/x" for i in res["items"])
    ats = [i["at"] for i in res["items"]]
    assert ats == sorted(ats, reverse=True)


@pytest.mark.asyncio
async def test_unconnected_user_hides_card(fake):
    ghost = SimpleNamespace(id="x", username="ghost", is_admin=False)
    res = await git_router.git_activity(scope="mine", limit=5, user=ghost)
    assert res == {"connected": False, "scope": "mine", "items": []}
    assert not any(c[0] == "/repos/issues/search" for c in fake.calls)


@pytest.mark.asyncio
async def test_unconnected_user_all_scope_shows_public_only(monkeypatch):
    """계정 없는 사용자 "전체" — 공개 저장소(소유자도 공개)의 이슈·PR·커밋 묶음만."""
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path.replace("/api/v1", "")
        seen.append((path, dict(req.url.params), req.headers.get("Sudo")))
        if path == "/user":
            return httpx.Response(404, json={})
        if path == "/repos/search":
            return httpx.Response(200, json={"data": [
                {"full_name": "o/pub", "private": False, "owner": {"visibility": "public"}},
                {"full_name": "o/priv", "private": True, "owner": {"visibility": "public"}},
                {"full_name": "o/int", "private": False, "internal": True},
                {"full_name": "hidden/x", "private": False, "owner": {"visibility": "private"}},
            ]})
        if path == "/repos/issues/search":
            return httpx.Response(200, json=[_issue(1, "공개 이슈", repo="o/pub"), _issue(2, "비공개", repo="o/priv"),
                                             _issue(3, "숨은 조직", repo="hidden/x")])
        return httpx.Response(404, json={})

    client = httpx.AsyncClient(base_url="http://gitea/api/v1", transport=httpx.MockTransport(handler))
    monkeypatch.setattr(gitea, "_get_client", lambda: client)

    async def cached():
        return [RecentCommit(repo_full_name="o/pub", repo_name="pub", sha="a", author_name="도윤", author_date="2026-10-15T09:40:00Z"),
                RecentCommit(repo_full_name="o/priv", repo_name="priv", sha="b", author_name="관리자", author_date="2026-10-15T11:00:00Z")]
    monkeypatch.setattr(git_router, "_cached_recent_commits", cached)

    ghost = SimpleNamespace(id="x", username="ghost", is_admin=False)
    res = await git_router.git_activity(scope="all", limit=5, user=ghost)
    assert res["connected"] is False
    assert {(i["kind"], i["repo_full_name"]) for i in res["items"]} == {("issue_open", "o/pub"), ("commits", "o/pub")}
    # 타 사용자 권한(Sudo)으로 조회하지 않음
    assert all(s[2] is None for s in seen if s[0] != "/user")
