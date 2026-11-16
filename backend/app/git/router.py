"""Git (Gitea) API router."""

import asyncio
import logging
import re
import time
from urllib.parse import urlsplit, urlunsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel

from app.auth.deps import get_current_user
from app.config import get_settings
from app.db.models import User
from app.git import gitea
from app.git.schemas import (
    Branch,
    Commit,
    CommitStatus,
    CommitUser,
    ContentEntry,
    CreateCommentRequest,
    CreateIssueRequest,
    CreateLabelRequest,
    FileContent,
    Issue,
    IssueComment,
    IssueUser,
    Label,
    PullRequest,
    RecentCommit,
    RepoDetail,
    RepoListResponse,
    RepoOwner,
    RepoSummary,
    SetIssueLabelsRequest,
    LastCommit,
    RepoStats,
    StarState,
    UpdateIssueRequest,
)

logger = logging.getLogger(__name__)

# ─── 요청별 사용자 권한 적용 ───
# Gitea 호출 토큰은 관리자 토큰이다. 사용자 요청은 반드시 해당 사용자 권한(Sudo)으로만 대행한다.
# Gitea 계정이 없는 사용자는 공개 저장소 읽기만 허용한다 — 쓰기는 403, 비공개·내부 저장소는 404.

_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
_ACCOUNT_TTL = 60.0
_account_cache: dict[str, tuple[float, bool]] = {}


async def _has_gitea_account(username: str) -> bool:
    now = time.monotonic()
    hit = _account_cache.get(username)
    if hit and now - hit[0] < _ACCOUNT_TTL:
        return hit[1]
    with gitea.system_call():
        ok = await gitea.user_exists(username)
    _account_cache[username] = (now, ok)
    return ok


async def git_identity(request: Request, user: User = Depends(get_current_user)) -> str | None:
    """이 요청의 Gitea 권한 주체. 연결된 계정이면 그 이름(Sudo), 없으면 None(공개 읽기 전용)."""
    owner = request.path_params.get("owner")
    repo = request.path_params.get("repo")
    for v in (owner, repo):
        if v is not None and (not _NAME_RE.match(v) or v in (".", "..")):
            raise HTTPException(status_code=404, detail="Repository not found")
    username = (getattr(user, "username", "") or "").strip()
    try:
        connected = bool(username) and await _has_gitea_account(username)
    except Exception as e:
        logger.warning("Git 계정 확인 실패 (%s): %s", username, e)
        raise HTTPException(status_code=502, detail="Git 서버에 연결하지 못했습니다")
    if connected:
        gitea.act_as(username)
        request.state.git_user = username
        return username

    gitea.act_as(None)
    request.state.git_user = None
    if request.method not in ("GET", "HEAD"):
        raise HTTPException(status_code=403, detail="Git 계정이 연결된 사용자만 할 수 있습니다")
    if owner and repo:
        try:
            with gitea.system_call():
                data = await gitea.get_repo(owner, repo)
        except Exception:
            raise HTTPException(status_code=404, detail="Repository not found")
        if not gitea._is_public_repo(data):
            raise HTTPException(status_code=404, detail="Repository not found")
    return None


def _is_anonymous(request: Request) -> bool:
    return getattr(request.state, "git_user", None) is None


router = APIRouter(prefix="/api/git", tags=["git"], dependencies=[Depends(git_identity)])


def _public_url(url: str | None) -> str:
    """Gitea 가 API 요청 Host(내부 http://gitea:3000) 로 생성한 링크를 브라우저용 공개 주소로 변환한다.

    Gitea 1.2x 는 html_url·clone_url·avatar_url 의 호스트를 요청 Host 에서 가져오고 경로(/git/…)만
    ROOT_URL 을 따른다. 따라서 내부 주소(settings.gitea_url)의 scheme·호스트만 공개 주소
    (GITEA_EXTERNAL_URL, 비어 있으면 APP_URL/git/)의 값으로 치환한다. 이미 공개 주소면 변경하지 않는다."""
    if not url:
        return ""
    settings = get_settings()
    try:
        u = urlsplit(url)
        internal = urlsplit(settings.gitea_url)
        if not u.netloc or u.netloc.lower() != internal.netloc.lower():
            return url
        pub = urlsplit(settings.gitea_external_url or f"{settings.app_url.rstrip('/')}/git/")
        if not pub.netloc:
            return url
        return urlunsplit((pub.scheme or u.scheme, pub.netloc, u.path, u.query, u.fragment))
    except ValueError:
        return url


def _map_repo_summary(r: dict) -> RepoSummary:
    owner = r.get("owner", {})
    return RepoSummary(
        id=r.get("id", 0),
        name=r.get("name", ""),
        full_name=r.get("full_name", ""),
        description=r.get("description") or "",
        owner=RepoOwner(
            login=owner.get("login", ""),
            avatar_url=_public_url(owner.get("avatar_url", "")),
        ),
        html_url=_public_url(r.get("html_url", "")),
        default_branch=r.get("default_branch", "main"),
        stars_count=r.get("stars_count", 0),
        forks_count=r.get("forks_count", 0),
        open_issues_count=r.get("open_issues_count", 0),
        updated_at=r.get("updated_at", ""),
        language=r.get("language") or "",
        private=r.get("private", False),
    )


def _map_issue_user(u: dict | None) -> IssueUser | None:
    if not u:
        return None
    return IssueUser(login=u.get("login", ""), avatar_url=_public_url(u.get("avatar_url", "")))


def _map_assignees(users: list[dict] | None) -> list[IssueUser]:
    return [m for m in (_map_issue_user(u) for u in (users or [])) if m is not None]


def _map_labels(labels: list[dict] | None) -> list[Label]:
    if not labels:
        return []
    return [
        Label(id=l.get("id", 0), name=l.get("name", ""), color=l.get("color", ""))
        for l in labels
    ]


# ─── Recent Commits (cross-repo, cached) ───

_recent_commits_cache: list[RecentCommit] = []
_recent_commits_ts: float = 0
_RECENT_COMMITS_TTL = 120  # seconds
# Lock prevents thundering-herd: when the cache expires, only ONE coroutine
# refreshes; everyone else waits on the same lock and reuses the fresh result.
_recent_commits_lock = asyncio.Lock()


async def _refresh_recent_commits() -> list[RecentCommit]:
    """Fetch recent commits from top 5 repos in parallel.

    공용 캐시이므로 시스템 권한으로 수집한다. 반환 시 반드시 사용자 기준으로 필터링한다(_visible_for).
    """
    with gitea.system_call():
        return await _refresh_recent_commits_inner()


async def _visible_for(request: Request) -> set[str]:
    """요청 사용자가 열람 가능한 저장소 full_name."""
    who = getattr(request.state, "git_user", None)
    if who:
        return await gitea.visible_repo_names(who)
    with gitea.system_call():
        return await gitea.public_repo_names()


async def _refresh_recent_commits_inner() -> list[RecentCommit]:
    try:
        repos, _ = await gitea.search_repos("", 1, 5, "updated")
    except Exception as e:
        logger.warning("Failed to fetch repos for recent commits: %s", e)
        return []

    async def _fetch(r: dict) -> list[RecentCommit]:
        owner = r.get("owner", {}).get("login", "")
        name = r.get("name", "")
        full_name = r.get("full_name", "")
        if not owner or not name:
            return []
        try:
            commits = await gitea.get_commits(owner, name, page=1)
            out = []
            for c in commits[:3]:
                cd = c.get("commit", {})
                ad = cd.get("author", {})
                out.append(RecentCommit(
                    repo_full_name=full_name, repo_name=name,
                    sha=c.get("sha", ""), message=cd.get("message", ""),
                    author_name=ad.get("name", ""), author_date=ad.get("date", ""),
                    branch=r.get("default_branch") or "",
                ))
            return out
        except Exception as e:
            logger.warning("Failed to fetch commits for %s: %s", full_name, e)
            return []

    results = await asyncio.gather(*[_fetch(r) for r in repos])
    all_commits = [c for batch in results for c in batch]
    all_commits.sort(key=lambda c: c.author_date, reverse=True)
    return all_commits[:20]


@router.get("/recent-commits", response_model=list[RecentCommit])
async def recent_commits(
    request: Request,
    limit: int = Query(5, ge=1, le=20),
    user: User = Depends(get_current_user),
):
    try:
        visible = await _visible_for(request)
    except Exception:
        visible = set()
    return [c for c in await _cached_recent_commits() if c.repo_full_name in visible][:limit]


async def _cached_recent_commits() -> list[RecentCommit]:
    global _recent_commits_cache, _recent_commits_ts
    now = time.monotonic()
    expired = now - _recent_commits_ts > _RECENT_COMMITS_TTL or not _recent_commits_cache
    if expired:
        async with _recent_commits_lock:
            # Re-check after acquiring the lock — another coroutine may have refreshed it.
            now2 = time.monotonic()
            if now2 - _recent_commits_ts > _RECENT_COMMITS_TTL or not _recent_commits_cache:
                _recent_commits_cache = await _refresh_recent_commits()
                _recent_commits_ts = now2
    return _recent_commits_cache


# ─── 대시보드 Git 활동 ───
# 범위 mine = 본인 대상 항목(리뷰 요청 · 배정 · 멘션, 열린 것만), all = 열람 가능한 최근 이슈·PR + 저장소별 최근 커밋 묶음.
# Gitea 에 해당 사용자가 없으면(connected=false) 프런트는 카드 전체를 숨긴다.

_MINE_FILTERS = (("review", {"type": "pulls", "review_requested": "true"}),
                 ("assigned", {"assigned": "true"}),
                 ("mention", {"mentioned": "true"}))


def _activity_from_issue(it: dict, reason: str | None) -> dict:
    repo = it.get("repository") or {}
    pr = it.get("pull_request")
    is_pr = bool(pr)
    state = it.get("state") or "open"
    if reason:
        kind = reason
    elif is_pr:
        kind = "pr_merged" if (pr or {}).get("merged") else ("pr_closed" if state == "closed" else "pr_open")
    else:
        kind = "issue_closed" if state == "closed" else "issue_open"
    return {
        "kind": kind,
        "is_pull": is_pr,
        "number": it.get("number"),
        "title": it.get("title") or "",
        "repo_full_name": repo.get("full_name") or "",
        "repo_name": repo.get("name") or "",
        "author": ((it.get("user") or {}).get("login") or ""),
        "at": it.get("updated_at") or it.get("created_at") or "",
        "count": None,
        "authors": [],
        "branch": "",
    }


def _commit_groups(commits: list[RecentCommit]) -> list[dict]:
    groups: dict[str, dict] = {}
    for c in commits:
        g = groups.get(c.repo_full_name)
        if g is None:
            g = groups[c.repo_full_name] = {
                "kind": "commits", "is_pull": False, "number": None, "title": "",
                "repo_full_name": c.repo_full_name, "repo_name": c.repo_name,
                "author": c.author_name, "at": c.author_date, "count": 0, "authors": [],
                "branch": c.branch,
            }
        g["count"] += 1
        if c.author_name and c.author_name not in g["authors"]:
            g["authors"].append(c.author_name)
        if c.author_date > g["at"]:
            g["at"] = c.author_date
    return list(groups.values())


@router.get("/activity")
async def git_activity(
    scope: str = Query("mine", pattern="^(mine|all)$"),
    limit: int = Query(5, ge=1, le=20),
    user: User = Depends(get_current_user),
):
    try:
        connected = await gitea.user_exists(user.username)
    except Exception as e:
        logger.warning("Git 계정 확인 실패 (%s): %s", user.username, e)
        raise HTTPException(status_code=502, detail="Git 서버에 연결하지 못했습니다")
    if not connected:
        # 계정이 없으면 "내 것"은 비어 있고, "전체"는 공개 저장소 활동만 포함(카드는 [전체] 하나로 표시)
        if scope != "all":
            return {"connected": False, "scope": scope, "items": []}
        try:
            public = await gitea.public_repo_names()
            rows = await gitea.search_public_issues({"state": "all", "limit": limit * 3}, public) if public else []
        except Exception as e:
            logger.warning("Git 활동(공개) 조회 실패: %s", e)
            raise HTTPException(status_code=502, detail="Git 활동을 불러오지 못했습니다")
        pub_items = [_activity_from_issue(it, None) for it in rows]
        pub_items += [g for g in _commit_groups(await _cached_recent_commits()) if g["repo_full_name"] in public]
        pub_items.sort(key=lambda x: x["at"] or "", reverse=True)
        return {"connected": False, "scope": scope, "items": pub_items[:limit]}

    items: list[dict] = []
    if scope == "mine":
        async def _one(reason: str, extra: dict) -> list[tuple[str, dict]]:
            rows = await gitea.search_issues_as(user.username, {"state": "open", "limit": limit, **extra})
            return [(reason, r) for r in rows]
        try:
            batches = await asyncio.gather(*[_one(r, f) for r, f in _MINE_FILTERS])
        except Exception as e:
            logger.warning("Git 활동(mine) 조회 실패 (%s): %s", user.username, e)
            raise HTTPException(status_code=502, detail="Git 활동을 불러오지 못했습니다")
        seen: set[tuple[str, int]] = set()
        # 선순위 사유 우선: 리뷰 요청 > 배정 > 멘션
        for batch in batches:
            for reason, it in batch:
                key = (((it.get("repository") or {}).get("full_name") or ""), it.get("number"))
                if key in seen:
                    continue
                seen.add(key)
                items.append(_activity_from_issue(it, reason))
    else:
        try:
            rows = await gitea.search_issues_as(user.username, {"state": "all", "limit": limit})
        except Exception as e:
            logger.warning("Git 활동(all) 조회 실패 (%s): %s", user.username, e)
            raise HTTPException(status_code=502, detail="Git 활동을 불러오지 못했습니다")
        items = [_activity_from_issue(it, None) for it in rows]
        # 커밋 캐시는 관리자 토큰으로 수집한 것이므로 해당 사용자가 열람 가능한 저장소만 유지
        try:
            visible = await gitea.visible_repo_names(user.username)
        except Exception:
            visible = set()
        items += [g for g in _commit_groups(await _cached_recent_commits()) if g["repo_full_name"] in visible]
    items.sort(key=lambda x: x["at"] or "", reverse=True)
    return {"connected": True, "scope": scope, "items": items[:limit]}


# ─── Repositories ───


@router.get("/repos", response_model=RepoListResponse)
async def list_repos(
    request: Request,
    query: str = "",
    page: int = Query(1, ge=1),
    limit: int = Query(20, ge=1, le=50),
    sort: str = "updated",
    user: User = Depends(get_current_user),
):
    repos, total = await gitea.search_repos(query, page, limit, sort, public_only=_is_anonymous(request))
    return RepoListResponse(
        repos=[_map_repo_summary(r) for r in repos],
        total=total,
    )


@router.get("/repos/{owner}/{repo}", response_model=RepoDetail)
async def get_repo(
    owner: str,
    repo: str,
    user: User = Depends(get_current_user),
):
    try:
        data = await gitea.get_repo(owner, repo)
    except Exception as e:
        logger.warning("Failed to fetch repo %s/%s: %s", owner, repo, e)
        raise HTTPException(status_code=404, detail="Repository not found")
    readme = await gitea.get_readme(owner, repo)
    o = data.get("owner", {})
    return RepoDetail(
        id=data.get("id", 0),
        name=data.get("name", ""),
        full_name=data.get("full_name", ""),
        description=data.get("description") or "",
        owner=RepoOwner(
            login=o.get("login", ""),
            avatar_url=_public_url(o.get("avatar_url", "")),
        ),
        html_url=_public_url(data.get("html_url", "")),
        default_branch=data.get("default_branch", "main"),
        stars_count=data.get("stars_count", 0),
        forks_count=data.get("forks_count", 0),
        open_issues_count=data.get("open_issues_count", 0),
        updated_at=data.get("updated_at", ""),
        language=data.get("language") or "",
        private=data.get("private", False),
        readme=readme,
        size=data.get("size", 0),
        created_at=data.get("created_at", ""),
        clone_url=_public_url(data.get("clone_url")),
        ssh_url=data.get("ssh_url") or "",
    )


# ─── Contents ───


@router.get("/repos/{owner}/{repo}/contents", response_model=list[ContentEntry])
async def list_contents(
    owner: str,
    repo: str,
    path: str = "",
    ref: str | None = None,
    with_commits: bool = Query(False, description="항목별 마지막 커밋(최대 100개, 동시 8)"),
    user: User = Depends(get_current_user),
):
    items = await gitea.get_contents(owner, repo, path, ref)
    out = [
        ContentEntry(
            name=i.get("name", ""),
            path=i.get("path", ""),
            type=i.get("type", "file"),
            size=i.get("size", 0),
            sha=i.get("sha", ""),
        )
        for i in items
    ]
    if with_commits and out:
        sem = asyncio.Semaphore(8)

        async def one(entry: ContentEntry):
            async with sem:
                c = await gitea.last_commit_for_path(owner, repo, entry.path, ref)
            if c:
                cd = c.get("commit", {}) or {}
                au = cd.get("author", {}) or {}
                entry.last_commit = LastCommit(
                    sha=c.get("sha", ""),
                    message=(cd.get("message") or "").split("\n", 1)[0],
                    author_name=au.get("name", ""),
                    date=au.get("date", ""),
                )

        await asyncio.gather(*(one(e) for e in out[:100]), return_exceptions=True)
    return out


@router.get("/repos/{owner}/{repo}/languages")
async def repo_languages(
    owner: str,
    repo: str,
    user: User = Depends(get_current_user),
):
    """언어별 바이트와 비율 — {languages: [{name, bytes, percent}]} (큰 순)."""
    try:
        data = await gitea.get_languages(owner, repo)
    except Exception as e:
        logger.warning("Failed to fetch languages %s/%s: %s", owner, repo, e)
        raise HTTPException(status_code=404, detail="Repository not found")
    total = sum(v for v in data.values() if isinstance(v, (int, float))) or 0
    langs = sorted(((k, int(v)) for k, v in data.items() if isinstance(v, (int, float))), key=lambda t: -t[1])
    return {"languages": [
        {"name": k, "bytes": v, "percent": round(v * 100 / total, 1) if total else 0.0} for k, v in langs
    ]}


@router.get("/repos/{owner}/{repo}/stats", response_model=RepoStats)
async def repo_stats(
    owner: str,
    repo: str,
    user: User = Depends(get_current_user),
):
    """태그·이슈(열림/닫힘)·PR(열림/닫힘)·커밋(기본 브랜치)·브랜치 총수. 조회 실패한 값은 null."""
    try:
        data = await gitea.get_repo(owner, repo)
    except Exception:
        raise HTTPException(status_code=404, detail="Repository not found")
    return RepoStats(**await gitea.repo_counts(owner, repo, data.get("default_branch")))


@router.get("/repos/{owner}/{repo}/star", response_model=StarState)
async def get_star(
    owner: str,
    repo: str,
    user: User = Depends(get_current_user),
):
    try:
        starred = await gitea.is_starred(owner, repo, user.username)
    except Exception as e:
        logger.warning("star 조회 실패 %s/%s (%s): %s", owner, repo, user.username, e)
        raise HTTPException(status_code=409, detail="Gitea 계정을 찾을 수 없어 스타를 볼 수 없습니다")
    return StarState(starred=starred)


async def _set_star(owner: str, repo: str, user: User, starred: bool) -> StarState:
    try:
        await gitea.set_star(owner, repo, user.username, starred)
    except Exception as e:
        logger.warning("star 변경 실패 %s/%s (%s): %s", owner, repo, user.username, e)
        raise HTTPException(status_code=409, detail="Gitea 계정을 찾을 수 없어 스타를 바꿀 수 없습니다")
    count = None
    try:
        count = (await gitea.get_repo(owner, repo)).get("stars_count")
    except Exception:
        pass
    return StarState(starred=starred, stars_count=count)


@router.put("/repos/{owner}/{repo}/star", response_model=StarState)
async def star_repo(owner: str, repo: str, user: User = Depends(get_current_user)):
    """스타 설정 — 사용자별(Gitea Sudo 로 해당 사용자 이름으로 수행)."""
    return await _set_star(owner, repo, user, True)


@router.delete("/repos/{owner}/{repo}/star", response_model=StarState)
async def unstar_repo(owner: str, repo: str, user: User = Depends(get_current_user)):
    return await _set_star(owner, repo, user, False)


@router.get("/repos/{owner}/{repo}/file", response_model=FileContent)
async def get_file(
    owner: str,
    repo: str,
    path: str,
    ref: str | None = None,
    user: User = Depends(get_current_user),
):
    data = await gitea.get_file(owner, repo, path, ref)
    if not data:
        raise HTTPException(status_code=404, detail="File not found")
    return FileContent(
        name=data.get("name", ""),
        path=data.get("path", ""),
        size=data.get("size", 0),
        sha=data.get("sha", ""),
        content=data.get("decoded_content"),
        too_large=data.get("too_large", False),
        encoding=data.get("encoding", ""),
    )


# ─── Branches ───


@router.get("/repos/{owner}/{repo}/branches", response_model=list[Branch])
async def list_branches(
    owner: str,
    repo: str,
    user: User = Depends(get_current_user),
):
    branches = await gitea.get_branches(owner, repo)
    return [
        Branch(
            name=b.get("name", ""),
            commit_sha=b.get("commit", {}).get("id", ""),
            commit_message=b.get("commit", {}).get("message", ""),
        )
        for b in branches
    ]


# ─── Commits ───


@router.get("/repos/{owner}/{repo}/commits", response_model=list[Commit])
async def list_commits(
    owner: str,
    repo: str,
    sha: str | None = None,
    page: int = Query(1, ge=1),
    user: User = Depends(get_current_user),
):
    commits = await gitea.get_commits(owner, repo, sha, page)
    result = []
    for c in commits:
        commit_data = c.get("commit", {})
        author_data = commit_data.get("author", {})
        committer_data = commit_data.get("committer", {})
        result.append(
            Commit(
                sha=c.get("sha", ""),
                message=commit_data.get("message", ""),
                author=CommitUser(
                    name=author_data.get("name", ""),
                    email=author_data.get("email", ""),
                    date=author_data.get("date", ""),
                ),
                committer=CommitUser(
                    name=committer_data.get("name", ""),
                    email=committer_data.get("email", ""),
                    date=committer_data.get("date", ""),
                ),
                html_url=_public_url(c.get("html_url", "")),
            )
        )
    return result


# ─── Issues ───


@router.get("/repos/{owner}/{repo}/issues", response_model=list[Issue])
async def list_issues(
    owner: str,
    repo: str,
    state: str = "open",
    page: int = Query(1, ge=1),
    labels: str | None = Query(None),
    user: User = Depends(get_current_user),
):
    issues = await gitea.get_issues(owner, repo, state, page, labels)
    return [
        Issue(
            number=i.get("number", 0),
            title=i.get("title", ""),
            body=i.get("body") or "",
            state=i.get("state", "open"),
            user=_map_issue_user(i.get("user")),
            labels=_map_labels(i.get("labels")),
            assignees=_map_assignees(i.get("assignees")),
            comments=i.get("comments", 0),
            created_at=i.get("created_at", ""),
            updated_at=i.get("updated_at", ""),
        )
        for i in issues
    ]


@router.post("/repos/{owner}/{repo}/issues", response_model=Issue)
async def create_issue(
    owner: str,
    repo: str,
    body: CreateIssueRequest,
    user: User = Depends(get_current_user),
):
    data = await gitea.create_issue(owner, repo, body.title, body.body, body.labels)
    return Issue(
        number=data.get("number", 0),
        title=data.get("title", ""),
        body=data.get("body") or "",
        state=data.get("state", "open"),
        user=_map_issue_user(data.get("user")),
        labels=_map_labels(data.get("labels")),
        assignees=_map_assignees(data.get("assignees")),
        comments=data.get("comments", 0),
        created_at=data.get("created_at", ""),
        updated_at=data.get("updated_at", ""),
    )


@router.get("/repos/{owner}/{repo}/labels", response_model=list[Label])
async def list_labels(
    owner: str,
    repo: str,
    user: User = Depends(get_current_user),
):
    """저장소 라벨 목록 — 이슈 생성 시 라벨 선택용."""
    return _map_labels(await gitea.get_labels(owner, repo))


@router.post("/repos/{owner}/{repo}/labels", response_model=Label)
async def create_label(
    owner: str,
    repo: str,
    body: CreateLabelRequest,
    user: User = Depends(get_current_user),
):
    """라벨 생성. 색은 서버가 팔레트에서 순환 배정(클라이언트는 이름만 전송)."""
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="라벨 이름이 비어 있습니다")
    data = await gitea.create_label(owner, repo, name)
    return _map_labels([data])[0]


@router.get("/repos/{owner}/{repo}/commits/{sha}/status", response_model=CommitStatus)
async def commit_status(
    owner: str,
    repo: str,
    sha: str,
    user: User = Depends(get_current_user),
):
    """커밋 CI/빌드 상태(combined). 프론트가 표시 중인 커밋만 지연 조회."""
    data = await gitea.get_commit_status(owner, repo, sha)
    return CommitStatus(
        state=data.get("state", "") or "",
        total_count=data.get("total_count", 0),
        statuses=data.get("statuses", []) or [],
    )


@router.get("/repos/{owner}/{repo}/issues/{index}", response_model=Issue)
async def get_issue(
    owner: str,
    repo: str,
    index: int,
    user: User = Depends(get_current_user),
):
    try:
        data = await gitea.get_issue(owner, repo, index)
    except Exception as e:
        logger.warning("Failed to fetch issue %s/%s#%d: %s", owner, repo, index, e)
        raise HTTPException(status_code=404, detail="Issue not found")
    return Issue(
        number=data.get("number", 0),
        title=data.get("title", ""),
        body=data.get("body") or "",
        state=data.get("state", "open"),
        user=_map_issue_user(data.get("user")),
        labels=_map_labels(data.get("labels")),
        assignees=_map_assignees(data.get("assignees")),
        comments=data.get("comments", 0),
        created_at=data.get("created_at", ""),
        updated_at=data.get("updated_at", ""),
    )


@router.patch("/repos/{owner}/{repo}/issues/{index}", response_model=Issue)
async def update_issue(
    owner: str,
    repo: str,
    index: int,
    body: UpdateIssueRequest,
    user: User = Depends(get_current_user),
):
    """이슈 수정 — 제목·본문·상태(open/closed: 닫기/다시 열기)·담당자."""
    payload = body.model_dump(exclude_none=True)
    if not payload:
        raise HTTPException(status_code=400, detail="변경할 내용이 없습니다")
    if "state" in payload and payload["state"] not in ("open", "closed"):
        raise HTTPException(status_code=400, detail="state 는 open 또는 closed")
    if "title" in payload and not payload["title"].strip():
        raise HTTPException(status_code=400, detail="제목이 비었습니다")
    try:
        data = await gitea.edit_issue(owner, repo, index, payload)
    except Exception as e:
        status = getattr(getattr(e, "response", None), "status_code", None)
        logger.warning("Failed to edit issue %s/%s#%d: %s", owner, repo, index, e)
        if status == 404:
            raise HTTPException(status_code=404, detail="Issue not found")
        if status == 422:
            raise HTTPException(status_code=400, detail="담당자 이름을 확인하세요")
        raise HTTPException(status_code=502, detail="이슈 수정 실패")
    return Issue(
        number=data.get("number", 0),
        title=data.get("title", ""),
        body=data.get("body") or "",
        state=data.get("state", "open"),
        user=_map_issue_user(data.get("user")),
        labels=_map_labels(data.get("labels")),
        assignees=_map_assignees(data.get("assignees")),
        comments=data.get("comments", 0),
        created_at=data.get("created_at", ""),
        updated_at=data.get("updated_at", ""),
    )


@router.patch("/repos/{owner}/{repo}/issues/{index}/labels", response_model=Issue)
async def set_issue_labels(
    owner: str,
    repo: str,
    index: int,
    body: SetIssueLabelsRequest,
    user: User = Depends(get_current_user),
):
    """이슈 라벨을 전체 교체(PATCH 1회). 교체된 최신 이슈를 반환."""
    try:
        data = await gitea.replace_issue_labels(owner, repo, index, body.labels)
    except Exception as e:
        logger.warning("Failed to set labels %s/%s#%d: %s", owner, repo, index, e)
        raise HTTPException(status_code=502, detail="라벨 변경 실패")
    return Issue(
        number=data.get("number", 0),
        title=data.get("title", ""),
        body=data.get("body") or "",
        state=data.get("state", "open"),
        user=_map_issue_user(data.get("user")),
        labels=_map_labels(data.get("labels")),
        assignees=_map_assignees(data.get("assignees")),
        comments=data.get("comments", 0),
        created_at=data.get("created_at", ""),
        updated_at=data.get("updated_at", ""),
    )


@router.get(
    "/repos/{owner}/{repo}/issues/{index}/comments",
    response_model=list[IssueComment],
)
async def list_issue_comments(
    owner: str,
    repo: str,
    index: int,
    user: User = Depends(get_current_user),
):
    comments = await gitea.get_issue_comments(owner, repo, index)
    return [
        IssueComment(
            id=c.get("id", 0),
            body=c.get("body") or "",
            user=_map_issue_user(c.get("user")),
            created_at=c.get("created_at", ""),
            updated_at=c.get("updated_at", ""),
        )
        for c in comments
    ]


@router.post(
    "/repos/{owner}/{repo}/issues/{index}/comments",
    response_model=IssueComment,
)
async def add_issue_comment(
    owner: str,
    repo: str,
    index: int,
    body: CreateCommentRequest,
    user: User = Depends(get_current_user),
):
    data = await gitea.create_issue_comment(owner, repo, index, body.body)
    return IssueComment(
        id=data.get("id", 0),
        body=data.get("body") or "",
        user=_map_issue_user(data.get("user")),
        created_at=data.get("created_at", ""),
        updated_at=data.get("updated_at", ""),
    )


# ─── Pull Requests ───


@router.get("/repos/{owner}/{repo}/pulls", response_model=list[PullRequest])
async def list_pulls(
    owner: str,
    repo: str,
    state: str = "open",
    page: int = Query(1, ge=1),
    user: User = Depends(get_current_user),
):
    pulls = await gitea.get_pulls(owner, repo, state, page)
    return [
        PullRequest(
            number=p.get("number", 0),
            title=p.get("title", ""),
            body=p.get("body") or "",
            state=p.get("state", "open"),
            user=_map_issue_user(p.get("user")),
            labels=_map_labels(p.get("labels")),
            head_branch=p.get("head", {}).get("label", ""),
            base_branch=p.get("base", {}).get("label", ""),
            mergeable=p.get("mergeable"),
            merged=p.get("merged", False),
            comments=p.get("comments", 0),
            created_at=p.get("created_at", ""),
            updated_at=p.get("updated_at", ""),
        )
        for p in pulls
    ]


@router.get("/repos/{owner}/{repo}/pulls/{index}", response_model=PullRequest)
async def get_pull(
    owner: str,
    repo: str,
    index: int,
    user: User = Depends(get_current_user),
):
    try:
        data = await gitea.get_pull(owner, repo, index)
    except Exception as e:
        logger.warning("Failed to fetch pull request %s/%s#%d: %s", owner, repo, index, e)
        raise HTTPException(status_code=404, detail="Pull request not found")
    return PullRequest(
        number=data.get("number", 0),
        title=data.get("title", ""),
        body=data.get("body") or "",
        state=data.get("state", "open"),
        user=_map_issue_user(data.get("user")),
        labels=_map_labels(data.get("labels")),
        head_branch=data.get("head", {}).get("label", ""),
        base_branch=data.get("base", {}).get("label", ""),
        mergeable=data.get("mergeable"),
        merged=data.get("merged", False),
        comments=data.get("comments", 0),
        created_at=data.get("created_at", ""),
        updated_at=data.get("updated_at", ""),
    )


# ─── PR Merge & Review ───


class MergePRRequest(BaseModel):
    merge_style: str = "merge"  # merge, rebase, squash
    title: str = ""
    message: str = ""


class ReviewRequest(BaseModel):
    body: str
    event: str = "COMMENT"  # COMMENT, APPROVED, REQUEST_CHANGES


@router.post("/repos/{owner}/{repo}/pulls/{index}/merge")
async def merge_pull(
    owner: str,
    repo: str,
    index: int,
    body: MergePRRequest = MergePRRequest(),
    user: User = Depends(get_current_user),
):
    try:
        result = await gitea.merge_pull(
            owner, repo, index,
            merge_style=body.merge_style,
            title=body.title,
            message=body.message,
        )
    except Exception as e:
        logger.warning("Failed to merge PR %s/%s#%d: %s", owner, repo, index, e)
        raise HTTPException(status_code=400, detail=str(e))
    return result


@router.post("/repos/{owner}/{repo}/pulls/{index}/reviews")
async def create_review(
    owner: str,
    repo: str,
    index: int,
    body: ReviewRequest,
    user: User = Depends(get_current_user),
):
    try:
        result = await gitea.create_pr_review(
            owner, repo, index,
            body=body.body,
            event=body.event,
        )
    except Exception as e:
        logger.warning("Failed to create review %s/%s#%d: %s", owner, repo, index, e)
        raise HTTPException(status_code=400, detail=str(e))
    return result
