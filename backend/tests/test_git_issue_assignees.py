"""이슈 응답에 담당자(assignees)가 실린다 — 목록·상세·라벨 교체 모두.

Gitea 호출은 가짜로 바꾼다. 여기서 보는 것은 응답 매핑이다("담당 이름").
"""

import pytest

from app.git import router as git_router
from app.git.schemas import SetIssueLabelsRequest


def _issue(number=91, assignees=None):
    return {
        "number": number,
        "title": "모바일 탭바 배지 누락",
        "body": "본문",
        "state": "open",
        "user": {"login": "junho", "avatar_url": ""},
        "labels": [{"id": 1, "name": "bug", "color": "ff0000"}],
        "assignees": assignees,
        "comments": 4,
        "created_at": "2026-10-13T00:00:00Z",
        "updated_at": "2026-10-13T00:00:00Z",
    }


@pytest.fixture()
def fake_gitea(monkeypatch):
    store = {"issue": _issue(assignees=[{"login": "haneul", "avatar_url": "a"}, None])}

    async def get_issues(owner, repo, state, page, labels):
        return [store["issue"], _issue(number=90, assignees=None)]

    async def get_issue(owner, repo, index):
        return store["issue"]

    async def replace_issue_labels(owner, repo, index, labels):
        return store["issue"]

    monkeypatch.setattr(git_router.gitea, "get_issues", get_issues)
    monkeypatch.setattr(git_router.gitea, "get_issue", get_issue)
    monkeypatch.setattr(git_router.gitea, "replace_issue_labels", replace_issue_labels)
    return store


@pytest.mark.asyncio
async def test_list_issues_maps_assignees(fake_gitea):
    res = await git_router.list_issues("just", "ws", state="open", page=1, labels=None, user=None)
    assert [a.login for a in res[0].assignees] == ["haneul"]  # None 항목은 건너뛴다
    assert res[1].assignees == []  # Gitea 가 null 을 줘도 빈 배열


@pytest.mark.asyncio
async def test_get_issue_maps_assignees(fake_gitea):
    res = await git_router.get_issue("just", "ws", 91, user=None)
    assert res.assignees[0].login == "haneul"
    assert res.labels[0].name == "bug"


@pytest.mark.asyncio
async def test_set_labels_keeps_assignees(fake_gitea):
    res = await git_router.set_issue_labels("just", "ws", 91, SetIssueLabelsRequest(labels=[1]), user=None)
    assert res.assignees[0].login == "haneul"
