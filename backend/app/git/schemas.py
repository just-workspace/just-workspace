"""Pydantic models for Git API responses."""

from pydantic import BaseModel


class RepoOwner(BaseModel):
    login: str
    avatar_url: str = ""


class RepoSummary(BaseModel):
    id: int
    name: str
    full_name: str
    description: str = ""
    owner: RepoOwner
    html_url: str
    default_branch: str = "main"
    stars_count: int = 0
    forks_count: int = 0
    open_issues_count: int = 0
    updated_at: str = ""
    language: str = ""
    private: bool = False


class RepoListResponse(BaseModel):
    repos: list[RepoSummary]
    total: int


class RepoDetail(RepoSummary):
    readme: str | None = None
    size: int = 0
    created_at: str = ""
    # Gitea 가 ROOT_URL 로 만든 공개 주소 — 프런트가 추측하지 않게 그대로 넘긴다
    clone_url: str = ""
    ssh_url: str = ""


class LastCommit(BaseModel):
    sha: str = ""
    message: str = ""
    author_name: str = ""
    date: str = ""


class ContentEntry(BaseModel):
    name: str
    path: str
    type: str  # "file" | "dir" | "symlink" | "submodule"
    size: int = 0
    sha: str = ""
    # with_commits=true 로 부를 때만 채운다(항목마다 Gitea 커밋 조회가 한 번씩 든다)
    last_commit: LastCommit | None = None


class FileContent(BaseModel):
    name: str
    path: str
    size: int = 0
    sha: str = ""
    content: str | None = None
    too_large: bool = False
    encoding: str = ""


class Branch(BaseModel):
    name: str
    commit_sha: str = ""
    commit_message: str = ""


class CommitUser(BaseModel):
    name: str = ""
    email: str = ""
    date: str = ""


class Commit(BaseModel):
    sha: str
    message: str = ""
    author: CommitUser | None = None
    committer: CommitUser | None = None
    html_url: str = ""


class IssueUser(BaseModel):
    login: str
    avatar_url: str = ""


class Label(BaseModel):
    id: int
    name: str
    color: str = ""


class Issue(BaseModel):
    number: int
    title: str
    body: str = ""
    state: str = "open"
    user: IssueUser | None = None
    labels: list[Label] = []
    # 담당자 — 이슈 상세 "담당 이름"(시안 GT3). 변경은 PATCH /issues/{index} 의 assignees.
    assignees: list[IssueUser] = []
    comments: int = 0
    created_at: str = ""
    updated_at: str = ""


class IssueComment(BaseModel):
    id: int
    body: str = ""
    user: IssueUser | None = None
    created_at: str = ""
    updated_at: str = ""


class CommitStatus(BaseModel):
    """커밋 CI/빌드 상태 (Gitea combined status). state: success/failure/pending/error/warning/(빈=없음)."""
    state: str = ""
    total_count: int = 0
    statuses: list[dict] = []


class UpdateIssueRequest(BaseModel):
    title: str | None = None
    body: str | None = None
    state: str | None = None  # open | closed
    assignees: list[str] | None = None  # Gitea 로그인 이름 목록([] = 담당 해제)


class StarState(BaseModel):
    starred: bool
    stars_count: int | None = None


class RepoStats(BaseModel):
    tags: int | None = None
    open_issues: int | None = None
    closed_issues: int | None = None
    open_pulls: int | None = None
    closed_pulls: int | None = None
    commits: int | None = None
    branches: int | None = None


class CreateIssueRequest(BaseModel):
    title: str
    body: str = ""
    # 라벨 ID 목록(선택) — Gitea 라벨 id. 빈 목록이면 라벨 없이 생성.
    labels: list[int] = []


class CreateCommentRequest(BaseModel):
    body: str


class CreateLabelRequest(BaseModel):
    # 색은 서버가 팔레트에서 배정한다 — 클라이언트는 이름만 보낸다.
    name: str


class SetIssueLabelsRequest(BaseModel):
    # 이슈에 붙일 라벨 id 전체(교체). 빈 목록이면 라벨 모두 제거.
    labels: list[int] = []


class RecentCommit(BaseModel):
    repo_full_name: str
    repo_name: str
    sha: str
    message: str = ""
    author_name: str = ""
    author_date: str = ""
    # 커밋을 읽은 브랜치(저장소 기본 브랜치) — 대시보드 Git 활동 "main 에 3커밋"
    branch: str = ""


class PullRequest(BaseModel):
    number: int
    title: str
    body: str = ""
    state: str = "open"
    user: IssueUser | None = None
    labels: list[Label] = []
    head_branch: str = ""
    base_branch: str = ""
    mergeable: bool | None = None
    merged: bool = False
    comments: int = 0
    created_at: str = ""
    updated_at: str = ""
