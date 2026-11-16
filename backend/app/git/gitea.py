"""Gitea API client with httpx singleton."""

import base64
import contextlib
import contextvars
from urllib.parse import quote

import httpx

from app.config import get_settings

settings = get_settings()

# 아래 `_client()` 함수와 이름이 중복되면 함수가 이 변수를 덮어쓰므로 이름을 분리한다.
_http: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _http
    if _http is None or _http.is_closed:
        _http = httpx.AsyncClient(
            base_url=f"{settings.gitea_url}/api/v1",
            headers={"Authorization": f"token {settings.gitea_token}"},
            timeout=15.0,
        )
    return _http


# ─── 호출 권한 주체 ───
# 사용자 요청은 해당 사용자 권한(Gitea Sudo)으로만 Gitea 를 호출한다. 라우터 의존성(git_identity)이
# 요청마다 지정한다. 미지정(None)이면 시스템 호출(관리자 화면·캐시 수집 등)이며, 사용자 요청 경로에서는
# 라우터가 반드시 지정한다.
_acting_as: contextvars.ContextVar[str | None] = contextvars.ContextVar("gitea_acting_as", default=None)


def act_as(username: str | None) -> contextvars.Token:
    return _acting_as.set(username or None)


def acting_as() -> str | None:
    return _acting_as.get()


@contextlib.contextmanager
def system_call():
    """사용자와 무관한 수집(공용 캐시 등) — 결과는 반드시 호출자가 사용자 기준으로 필터링해야 한다."""
    tok = _acting_as.set(None)
    try:
        yield
    finally:
        _acting_as.reset(tok)


class _Scoped:
    """요청마다 현재 사용자의 Sudo 헤더를 추가한다(명시적 Sudo 가 있으면 유지)."""

    def __init__(self, inner):
        self._inner = inner

    def _kw(self, kw: dict) -> dict:
        who = _acting_as.get()
        if who:
            h = dict(kw.get("headers") or {})
            if not any(k.lower() == "sudo" for k in h):
                h["Sudo"] = who
            kw["headers"] = h
        return kw

    async def get(self, url, **kw):
        return await self._inner.get(url, **self._kw(kw))

    async def post(self, url, **kw):
        return await self._inner.post(url, **self._kw(kw))

    async def put(self, url, **kw):
        return await self._inner.put(url, **self._kw(kw))

    async def patch(self, url, **kw):
        return await self._inner.patch(url, **self._kw(kw))

    async def delete(self, url, **kw):
        return await self._inner.delete(url, **self._kw(kw))


def _client() -> _Scoped:
    return _Scoped(_get_client())


def _seg(v: str) -> str:
    """경로 조각 하나 — 슬래시·점 조각 주입 방지."""
    v = str(v)
    if not v or v in (".", "..") or "/" in v or "\\" in v:
        raise ValueError("invalid path segment")
    return quote(v, safe="")


def _subpath(path: str) -> str:
    """리포 안 경로(슬래시 허용) — '..' 조각 거부."""
    parts = [p for p in str(path or "").split("/") if p != ""]
    if any(p in (".", "..") or "\\" in p for p in parts):
        raise ValueError("invalid path")
    return "/".join(quote(p, safe="") for p in parts)


async def _get(path: str, params: dict | None = None) -> dict | list:
    client = _client()
    resp = await client.get(path, params=params)
    resp.raise_for_status()
    return resp.json()


async def _post(path: str, json: dict | None = None) -> dict:
    client = _client()
    resp = await client.post(path, json=json)
    resp.raise_for_status()
    return resp.json()


async def _put(path: str, json: dict | None = None) -> dict | list:
    client = _client()
    resp = await client.put(path, json=json)
    resp.raise_for_status()
    return resp.json()


# 라벨 색은 서버가 이 팔레트에서 순환 배정한다. 클라이언트의 임의 hex 전송을
# 차단하여 저장소별 색상 불일치를 방지한다. 다크 배경에서 가독성이 확보되는 채도.
_LABEL_PALETTE = [
    "#4d8dff", "#22a06b", "#d4a72c", "#e0533d",
    "#8b5cf6", "#0ea5e9", "#ec4899", "#64748b",
]


# ─── Repositories ───


async def search_repos(
    query: str = "",
    page: int = 1,
    limit: int = 20,
    sort: str = "updated",
    public_only: bool = False,
) -> tuple[list[dict], int]:
    """Search repositories. Returns (repos, total_count).

    public_only: Git 계정이 없는 사용자 — 공개 저장소만(서버에서 필터링).
    """
    # Gitea /repos/search 는 order 기본값이 asc 이므로 "updated" 로 정렬하면 가장 오래 변경되지 않은 저장소부터 반환된다.
    # 시간 기준 정렬은 최신 우선(desc), 이름순만 asc.
    order = "asc" if sort == "alpha" else "desc"
    params: dict = {"page": page, "limit": limit, "sort": sort, "order": order}
    if query:
        params["q"] = query
    if public_only:
        params["is_private"] = "false"
    client = _client()
    resp = await client.get("/repos/search", params=params)
    resp.raise_for_status()
    total = int(resp.headers.get("x-total-count", 0))
    data = resp.json().get("data", [])
    if public_only:
        data = [r for r in data if _is_public_repo(r)]
    return data, total


async def get_repo(owner: str, repo: str) -> dict:
    return await _get(f"/repos/{owner}/{repo}")


async def get_readme(owner: str, repo: str, ref: str | None = None) -> str | None:
    """Get decoded README content via raw endpoint."""
    client = _client()
    params = {}
    if ref:
        params["ref"] = ref
    for name in ("README.md", "readme.md", "README", "README.txt"):
        try:
            resp = await client.get(
                f"/repos/{owner}/{repo}/raw/{name}", params=params
            )
            if resp.status_code == 200:
                return resp.text
        except httpx.HTTPError:
            continue
    return None


# ─── Contents ───


async def get_contents(
    owner: str, repo: str, path: str = "", ref: str | None = None
) -> list[dict]:
    """Get directory listing."""
    params = {}
    if ref:
        params["ref"] = ref
    try:
        data = await _get(f"/repos/{owner}/{repo}/contents/{_subpath(path)}", params)
        if isinstance(data, list):
            return data
        return [data]
    except (httpx.HTTPStatusError, ValueError):
        return []


def _looks_binary(raw: bytes) -> bool:
    """텍스트 파일이 아닌지 여부 — NUL 이 있거나(git 과 동일 기준, 앞 8000바이트) UTF-8 로 디코드되지 않는 바이트가 많은 경우."""
    head = raw[:8000]
    if b"\x00" in head:
        return True
    try:
        raw.decode("utf-8")
        return False
    except UnicodeDecodeError:
        pass
    # UTF-8 이 아닌 텍스트 파일(EUC-KR·Latin-1 등)은 깨진 문자가 포함되어도 표시한다. 대체 문자가 30% 를 초과하면 바이너리로 판정한다
    text = head.decode("utf-8", errors="replace")
    return bool(text) and text.count("\ufffd") / len(text) > 0.3


async def get_file(
    owner: str, repo: str, path: str, ref: str | None = None
) -> dict | None:
    """Get file content, decoded from base64."""
    params = {}
    if ref:
        params["ref"] = ref
    try:
        data = await _get(f"/repos/{owner}/{repo}/contents/{_subpath(path)}", params)
        if isinstance(data, list):
            return None
        content = data.get("content", "")
        size = data.get("size", 0)
        if content and size <= 1_048_576:  # 1MB
            raw = base64.b64decode(content)
            # 바이너리(이미지·압축·글꼴…)는 텍스트로 디코드하지 않는다. 이전에는 errors="replace" 로 깨진 문자
            # 수천 줄을 전송하여 코드 뷰어가 그대로 렌더링했다. 내용 없음(None)이면 화면에 "원본 다운로드"만 표시된다.
            if _looks_binary(raw):
                data["decoded_content"] = None
                data["binary"] = True
            else:
                data["decoded_content"] = raw.decode("utf-8", errors="replace")
        elif size > 1_048_576:
            data["decoded_content"] = None
            data["too_large"] = True
        data.pop("content", None)
        return data
    except (httpx.HTTPStatusError, ValueError):
        return None


# ─── Branches ───


async def get_branches(owner: str, repo: str) -> list[dict]:
    """전체 브랜치 — Gitea 는 1회에 기본 페이지 크기만 반환한다. 페이지를 순회하며 수집한다(상한 500개)."""
    out: list[dict] = []
    for page in range(1, 11):
        rows = await _get(f"/repos/{owner}/{repo}/branches", {"page": page, "limit": 50})
        if not isinstance(rows, list) or not rows:
            break
        out.extend(rows)
        if len(rows) < 50:
            break
    return out


# ─── Commits ───


async def get_commits(
    owner: str, repo: str, sha: str | None = None, page: int = 1
) -> list[dict]:
    params: dict = {"page": page, "limit": 30}
    if sha:
        params["sha"] = sha
    return await _get(f"/repos/{owner}/{repo}/commits", params)


# ─── Issues ───


async def get_issues(
    owner: str, repo: str, state: str = "open", page: int = 1,
    labels: str | None = None,
) -> list[dict]:
    params = {"state": state, "page": page, "limit": 20, "type": "issues"}
    if labels:
        # Gitea 이슈 필터는 라벨 '이름'으로 매칭한다. 프론트가 전달한 id 목록을
        # 이름으로 변환하여 전달한다.
        names = await _label_ids_to_names(owner, repo, labels)
        if names:
            params["labels"] = names
    return await _get(f"/repos/{owner}/{repo}/issues", params)


async def _label_ids_to_names(owner: str, repo: str, ids_csv: str) -> str:
    try:
        want = {int(x) for x in ids_csv.split(",") if x.strip()}
    except ValueError:
        return ""
    if not want:
        return ""
    all_labels = await get_labels(owner, repo)
    names = [l.get("name", "") for l in all_labels if l.get("id") in want]
    return ",".join(n for n in names if n)


async def get_issue(owner: str, repo: str, index: int) -> dict:
    return await _get(f"/repos/{owner}/{repo}/issues/{index}")


async def create_issue(
    owner: str, repo: str, title: str, body: str = "", labels: list[int] | None = None
) -> dict:
    payload: dict = {"title": title, "body": body}
    if labels:
        payload["labels"] = labels
    return await _post(f"/repos/{owner}/{repo}/issues", json=payload)


async def get_labels(owner: str, repo: str) -> list[dict]:
    return await _get(f"/repos/{owner}/{repo}/labels", {"limit": 50})


async def create_label(owner: str, repo: str, name: str) -> dict:
    """라벨 생성. 색은 서버 팔레트에서 순환 배정(기존 라벨 수 기준)."""
    existing = await get_labels(owner, repo)
    color = _LABEL_PALETTE[len(existing) % len(_LABEL_PALETTE)]
    return await _post(
        f"/repos/{owner}/{repo}/labels", json={"name": name, "color": color}
    )


async def replace_issue_labels(
    owner: str, repo: str, index: int, label_ids: list[int]
) -> dict:
    """이슈의 라벨을 전체 교체(Gitea PUT). 교체 후 최신 이슈를 반환."""
    await _put(
        f"/repos/{owner}/{repo}/issues/{index}/labels", json={"labels": label_ids}
    )
    return await get_issue(owner, repo, index)


async def get_commit_status(owner: str, repo: str, ref: str) -> dict:
    """Gitea combined commit status(CI/빌드). 없으면 state 빈 문자열."""
    try:
        return await _get(f"/repos/{owner}/{repo}/commits/{_seg(ref)}/status")
    except Exception:
        return {"state": "", "total_count": 0, "statuses": []}


async def get_issue_comments(owner: str, repo: str, index: int) -> list[dict]:
    return await _get(f"/repos/{owner}/{repo}/issues/{index}/comments")


async def create_issue_comment(
    owner: str, repo: str, index: int, body: str
) -> dict:
    return await _post(
        f"/repos/{owner}/{repo}/issues/{index}/comments", json={"body": body}
    )


# ─── Pull Requests ───


async def get_pulls(
    owner: str, repo: str, state: str = "open", page: int = 1
) -> list[dict]:
    params = {"state": state, "page": page, "limit": 20}
    return await _get(f"/repos/{owner}/{repo}/pulls", params)


async def get_pull(owner: str, repo: str, index: int) -> dict:
    return await _get(f"/repos/{owner}/{repo}/pulls/{index}")


async def merge_pull(
    owner: str, repo: str, index: int,
    merge_style: str = "merge",
    title: str = "",
    message: str = "",
) -> dict:
    body: dict = {"Do": merge_style}
    if title:
        body["merge_message_field"] = title
    if message:
        body["merge_commit_id"] = message
    return await _post(f"/repos/{owner}/{repo}/pulls/{index}/merge", json=body)


async def create_pr_review(
    owner: str, repo: str, index: int,
    body: str, event: str = "COMMENT",
) -> dict:
    return await _post(
        f"/repos/{owner}/{repo}/pulls/{index}/reviews",
        json={"body": body, "event": event},
    )


# ─── 이슈 수정 · 언어 · 파일별 마지막 커밋 · 스타 · 총수 ───


async def _patch(path: str, json: dict | None = None) -> dict:
    client = _client()
    resp = await client.patch(path, json=json)
    resp.raise_for_status()
    return resp.json()


async def _total(path: str, params: dict | None = None) -> int | None:
    """목록 API 의 X-Total-Count(limit=1 로 1건만 조회한다). 헤더가 없으면 None."""
    client = _client()
    p = {"limit": 1, "page": 1, **(params or {})}
    resp = await client.get(path, params=p)
    resp.raise_for_status()
    v = resp.headers.get("X-Total-Count") or resp.headers.get("x-total-count")
    try:
        return int(v) if v is not None else None
    except ValueError:
        return None


async def edit_issue(owner: str, repo: str, index: int, payload: dict) -> dict:
    """이슈 수정(Gitea PATCH) — title/body/state(open|closed)/assignees(로그인 이름 목록)."""
    return await _patch(f"/repos/{owner}/{repo}/issues/{index}", json=payload)


async def get_languages(owner: str, repo: str) -> dict:
    """{언어: 바이트}"""
    data = await _get(f"/repos/{owner}/{repo}/languages")
    return data if isinstance(data, dict) else {}


async def last_commit_for_path(owner: str, repo: str, path: str, ref: str | None = None) -> dict | None:
    try:
        safe_path = _subpath(path)
    except ValueError:
        return None
    params: dict = {"path": safe_path, "limit": 1, "stat": "false", "verification": "false", "files": "false"}
    if ref:
        params["sha"] = ref
    try:
        data = await _get(f"/repos/{owner}/{repo}/commits", params)
    except httpx.HTTPStatusError:
        return None
    return data[0] if isinstance(data, list) and data else None


def _sudo(username: str) -> dict:
    # 관리자 토큰으로 해당 사용자를 대행한다(Gitea Sudo). 스타는 사용자별이므로 필요하다.
    return {"Sudo": username}


async def is_starred(owner: str, repo: str, username: str) -> bool:
    client = _client()
    resp = await client.get(f"/user/starred/{owner}/{repo}", headers=_sudo(username))
    if resp.status_code == 204:
        return True
    if resp.status_code == 404:
        return False
    resp.raise_for_status()
    return False


async def set_star(owner: str, repo: str, username: str, starred: bool) -> None:
    client = _client()
    if starred:
        resp = await client.put(f"/user/starred/{owner}/{repo}", headers=_sudo(username))
    else:
        resp = await client.delete(f"/user/starred/{owner}/{repo}", headers=_sudo(username))
    resp.raise_for_status()


async def repo_counts(owner: str, repo: str, default_branch: str | None = None) -> dict:
    """태그·닫힌 이슈·열린/닫힌 PR·커밋·브랜치 총수(X-Total-Count). 조회 실패한 값은 None."""
    import asyncio as _aio

    async def safe(coro):
        try:
            return await coro
        except Exception:
            return None

    base = f"/repos/{owner}/{repo}"
    commit_params = {"stat": "false", "verification": "false", "files": "false"}
    if default_branch:
        commit_params["sha"] = default_branch
    tags, closed_issues, open_issues, open_pulls, closed_pulls, commits, branches = await _aio.gather(
        safe(_total(f"{base}/tags")),
        safe(_total(f"{base}/issues", {"state": "closed", "type": "issues"})),
        safe(_total(f"{base}/issues", {"state": "open", "type": "issues"})),
        safe(_total(f"{base}/pulls", {"state": "open"})),
        safe(_total(f"{base}/pulls", {"state": "closed"})),
        safe(_total(f"{base}/commits", commit_params)),
        safe(_total(f"{base}/branches")),
    )
    return {
        "tags": tags, "open_issues": open_issues, "closed_issues": closed_issues,
        "open_pulls": open_pulls, "closed_pulls": closed_pulls,
        "commits": commits, "branches": branches,
    }


# ─── 대시보드 Git 활동 ───


async def user_exists(username: str) -> bool:
    """해당 사용자의 Gitea 존재 여부(연결된 계정). Sudo 로 /user 를 호출하여 확인한다."""
    client = _client()
    resp = await client.get("/user", headers=_sudo(username))
    if resp.status_code == 200:
        return True
    if resp.status_code in (401, 403, 404, 422):
        return False
    resp.raise_for_status()
    return False


async def search_issues_as(username: str, params: dict) -> list[dict]:
    """해당 사용자 관점의 이슈·PR 검색(/repos/issues/search, Sudo).
    review_requested·assigned·mentioned 는 '해당 사용자 기준' 필터이므로 Sudo 가 있어야 의미가 성립한다."""
    client = _client()
    resp = await client.get("/repos/issues/search", params=params, headers=_sudo(username))
    resp.raise_for_status()
    data = resp.json()
    return data if isinstance(data, list) else []


async def visible_repo_names(username: str, limit: int = 50) -> set[str]:
    """해당 사용자가 열람 가능한 저장소 full_name(최근 갱신 순 limit 개, Sudo)."""
    client = _client()
    # order 미지정 시 Gitea 기본값이 asc 이므로 "가장 오래 안 바뀐" 저장소부터 반환된다(search_repos 주석과 동일한 함정)
    resp = await client.get("/repos/search", params={"limit": limit, "sort": "updated", "order": "desc"}, headers=_sudo(username))
    resp.raise_for_status()
    return {r.get("full_name", "") for r in (resp.json().get("data") or [])}


def _is_public_repo(r: dict) -> bool:
    """계정이 없는 사용자도 열람 가능한 저장소 — 공개(private·internal 아님)이며 소유자(조직)도 공개."""
    if r.get("private") or r.get("internal"):
        return False
    vis = ((r.get("owner") or {}).get("visibility") or "public").lower()
    return vis == "public"


async def public_repo_names(limit: int = 50) -> set[str]:
    """공개 저장소 full_name(최근 갱신 순 limit 개) — Git 계정이 없는 사용자의 대시보드 "전체" 범위."""
    client = _client()
    resp = await client.get("/repos/search", params={"limit": limit, "sort": "updated", "order": "desc", "is_private": "false"})
    resp.raise_for_status()
    return {r.get("full_name", "") for r in (resp.json().get("data") or []) if _is_public_repo(r)}


async def search_public_issues(params: dict, public: set[str]) -> list[dict]:
    """최근 이슈·PR 중 공개 저장소 항목만(관리자 토큰으로 조회 후 공개 목록으로 필터링)."""
    client = _client()
    resp = await client.get("/repos/issues/search", params=params)
    resp.raise_for_status()
    data = resp.json()
    rows = data if isinstance(data, list) else []
    return [it for it in rows if ((it.get("repository") or {}).get("full_name") or "") in public]
