"""Git(Gitea 프록시) 보강 — 이슈 수정, 언어, 파일별 마지막 커밋, 스타(사용자별 Sudo), 총수.

Gitea HTTP 는 httpx MockTransport 로 흉내 낸다(실제 경로·헤더·쿼리를 본다).
"""

import json
from types import SimpleNamespace

import httpx
import pytest
from fastapi import HTTPException

from app.git import gitea
from app.git import router as git_router
from app.git.schemas import UpdateIssueRequest

USER = SimpleNamespace(id="u1", username="minji", is_admin=False)


@pytest.fixture()
def fake(monkeypatch):
    calls = []
    starred = {"minji": False}

    def handler(req: httpx.Request) -> httpx.Response:
        path = req.url.path.replace("/api/v1", "")
        q = dict(req.url.params)
        calls.append((req.method, path, q, req.headers.get("Sudo")))
        if path == "/repos/o/r/issues/7" and req.method == "PATCH":
            body = json.loads(req.content)
            issue = {"number": 7, "title": body.get("title", "old"), "body": body.get("body", ""),
                     "state": body.get("state", "open"), "user": {"login": "a"},
                     "assignees": [{"login": n} for n in body.get("assignees", [])], "labels": []}
            return httpx.Response(201, json=issue)
        if path == "/repos/o/r/issues/404" and req.method == "PATCH":
            return httpx.Response(404, json={})
        if path == "/repos/o/r/languages":
            return httpx.Response(200, json={"Python": 750, "Vue": 250})
        if path == "/repos/o/r/commits" and "path" in q:
            return httpx.Response(200, json=[{"sha": "abc" + q["path"], "commit": {
                "message": f"fix {q['path']}\n\n본문", "author": {"name": "민지", "date": "2026-10-01T00:00:00Z"}}}])
        if path == "/repos/o/r/contents/":
            return httpx.Response(200, json=[{"name": "a.py", "path": "a.py", "type": "file"},
                                             {"name": "src", "path": "src", "type": "dir"}])
        if path == "/user/starred/o/r":
            who = req.headers.get("Sudo")
            if who != "minji":
                return httpx.Response(404 if req.method == "GET" else 403)
            if req.method == "GET":
                return httpx.Response(204 if starred[who] else 404)
            starred[who] = req.method == "PUT"
            return httpx.Response(204)
        if path == "/repos/o/r":
            return httpx.Response(200, json={"default_branch": "main", "stars_count": 3 if starred["minji"] else 2})
        totals = {"/repos/o/r/tags": 4, "/repos/o/r/branches": 2, "/repos/o/r/commits": 120}
        if path in totals:
            return httpx.Response(200, json=[{}], headers={"X-Total-Count": str(totals[path])})
        if path == "/repos/o/r/issues":
            return httpx.Response(200, json=[{}], headers={"X-Total-Count": "9" if q.get("state") == "closed" else "3"})
        if path == "/repos/o/r/pulls":
            return httpx.Response(200, json=[{}], headers={"X-Total-Count": "5" if q.get("state") == "closed" else "1"})
        return httpx.Response(404, json={})

    client = httpx.AsyncClient(base_url="http://gitea/api/v1", transport=httpx.MockTransport(handler))
    monkeypatch.setattr(gitea, "_get_client", lambda: client)
    return SimpleNamespace(calls=calls, starred=starred)


@pytest.mark.asyncio
async def test_update_issue(fake):
    res = await git_router.update_issue("o", "r", 7, UpdateIssueRequest(state="closed", assignees=["haneul"]), user=USER)
    assert res.state == "closed" and [a.login for a in res.assignees] == ["haneul"]
    method, path, _, _ = [c for c in fake.calls if c[0] == "PATCH"][0]
    assert path == "/repos/o/r/issues/7"
    with pytest.raises(HTTPException) as e:
        await git_router.update_issue("o", "r", 7, UpdateIssueRequest(state="merged"), user=USER)
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        await git_router.update_issue("o", "r", 7, UpdateIssueRequest(), user=USER)
    assert e.value.status_code == 400
    with pytest.raises(HTTPException) as e:
        await git_router.update_issue("o", "r", 404, UpdateIssueRequest(title="x"), user=USER)
    assert e.value.status_code == 404


@pytest.mark.asyncio
async def test_languages_percent(fake):
    res = await git_router.repo_languages("o", "r", user=USER)
    assert res["languages"] == [{"name": "Python", "bytes": 750, "percent": 75.0},
                                {"name": "Vue", "bytes": 250, "percent": 25.0}]


@pytest.mark.asyncio
async def test_contents_with_last_commit(fake):
    plain = await git_router.list_contents("o", "r", path="", ref=None, with_commits=False, user=USER)
    assert all(e.last_commit is None for e in plain)
    assert not any("path" in c[2] for c in fake.calls)  # 기본은 커밋 조회 안 함
    res = await git_router.list_contents("o", "r", path="", ref="dev", with_commits=True, user=USER)
    by = {e.name: e for e in res}
    assert by["a.py"].last_commit.message == "fix a.py" and by["a.py"].last_commit.author_name == "민지"
    q = [c[2] for c in fake.calls if "path" in c[2]]
    assert {x["path"] for x in q} == {"a.py", "src"} and all(x["sha"] == "dev" for x in q)


@pytest.mark.asyncio
async def test_star_is_per_user_via_sudo(fake):
    assert (await git_router.get_star("o", "r", user=USER)).starred is False
    res = await git_router.star_repo("o", "r", user=USER)
    assert res.starred is True and res.stars_count == 3
    assert (await git_router.get_star("o", "r", user=USER)).starred is True
    assert all(c[3] == "minji" for c in fake.calls if c[1] == "/user/starred/o/r")
    res = await git_router.unstar_repo("o", "r", user=USER)
    assert res.starred is False
    # Gitea 에 없는 사용자 → 409
    ghost = SimpleNamespace(id="x", username="ghost", is_admin=False)
    with pytest.raises(HTTPException) as e:
        await git_router.star_repo("o", "r", user=ghost)
    assert e.value.status_code == 409


@pytest.mark.asyncio
async def test_repo_stats(fake):
    res = await git_router.repo_stats("o", "r", user=USER)
    assert res.model_dump() == {"tags": 4, "open_issues": 3, "closed_issues": 9, "open_pulls": 1,
                                "closed_pulls": 5, "commits": 120, "branches": 2}
    commit_q = [c[2] for c in fake.calls if c[1] == "/repos/o/r/commits"][0]
    assert commit_q["sha"] == "main" and commit_q["limit"] == "1"
