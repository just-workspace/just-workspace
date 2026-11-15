from datetime import datetime

from pydantic import BaseModel


class FileItem(BaseModel):
    name: str
    path: str  # virtual path (my/... or shared/...)
    is_dir: bool
    size: int = 0
    modified_at: datetime | None = None
    mime_type: str | None = None
    # 파일만. 크기+mtime(ns) 기반 — 다운로드 응답 ETag 와 같은 값이라 클라이언트가
    # 목록만 보고 "안 바뀐 파일" 을 가려낼 수 있다. 디렉터리 ETag 는 아직 없다.
    etag: str | None = None
    # 소유자({id, name}, 모르면 null) · 내 즐겨찾기 여부
    owner: dict | None = None
    is_starred: bool = False


class FileListResponse(BaseModel):
    path: str
    items: list[FileItem]


class StorageInfo(BaseModel):
    personal_used: int  # bytes
    shared_used: int
    total_available: int  # 0 = unlimited
    total_capacity: int = 0  # disk total bytes
    disk_used: int = 0  # disk used bytes


class MkdirRequest(BaseModel):
    path: str


class RenameRequest(BaseModel):
    path: str
    new_name: str


class MoveRequest(BaseModel):
    src: str
    dst: str
    copy: bool = False


class MultiDownloadRequest(BaseModel):
    paths: list[str]  # zip으로 묶을 파일/폴더 virtual paths


class ShareLinkCreate(BaseModel):
    # Office 문서(docx·xlsx·pptx 등)에서만 의미가 있다 — OnlyOffice 로 같이 편집(app/wopi/share.py).
    can_edit: bool = False
    path: str = ""
    expires_in: str | None = None  # "1h", "1d", "7d", None=unlimited
    one_time: bool = False
    # ── 추가 필드 ──
    paths: list[str] | None = None  # 둘 이상이면 묶음 링크(zip)
    password: str | None = None  # 주면 비밀번호 링크
    allow_download: bool = True  # false 면 미리보기만


class ShareLinkResponse(BaseModel):
    token: str
    url: str
    display_name: str
    expires_at: datetime | None
    max_downloads: int | None
    created_at: datetime
    id: str | None = None
    has_password: bool = False
    allow_download: bool = True
    item_count: int = 1
    is_folder: bool = False  # 폴더 하나짜리 링크 — 손님 화면에서 안을 둘러본다


class ShareLinkListItem(BaseModel):
    id: str
    token: str
    display_name: str
    file_path: str
    expires_at: datetime | None
    max_downloads: int | None
    download_count: int
    created_at: datetime
    # 같이 편집 링크면 주소가 /s/<token>(편집기), 아니면 /api/files/shared/<token>(내려받기).
    # 목록에서 링크를 다시 복사할 때 어느 주소인지 가려야 해서 내려준다(파일 UI 공유 모달).
    can_edit: bool = False
    has_password: bool = False
    allow_download: bool = True
    paths: list[str] = []  # 묶음 링크면 여러 개
    email_count: int = 0  # 이메일로 보낸 받는 사람 수(성공만, R7)
    is_folder: bool = False
    # false 면 "내려받기 막음"으로 바꿀 수 없다 — 파일 하나짜리 링크인데 미리보기가 안 되는 형식(죽은 링크가 된다)
    can_block_download: bool = True


class ShareLinkUpdate(BaseModel):
    password: str | None = None  # "" 이면 비밀번호 해제
    allow_download: bool | None = None
    expires_in: str | None = None  # 1h|1d|7d|never
    expires_at: str | None = None  # ISO (expires_in 보다 나중에 적용)
    max_downloads: int | None = None  # 0 이면 제한 없음


class ShareUnlockRequest(BaseModel):
    password: str = ""


class StarRequest(BaseModel):
    path: str


class RecentRequest(BaseModel):
    path: str  # my/.., shared/.., shared-with-me/<share_id>/<하위>


class ChannelShareRequest(BaseModel):
    channel_id: str
    paths: list[str]
    message: str | None = None  # 같이 보낼 글(선택)


class TrashItem(BaseModel):
    name: str
    original_path: str  # virtual path before deletion
    size: int = 0
    trashed_at: datetime | None = None
    trash_name: str  # unique name in .trash/ (for restore/permanent delete)


class TrashListResponse(BaseModel):
    items: list[TrashItem]
    # 휴지통 자동 삭제 기간(일, 0=자동 삭제 안 함). 관리자 설정값 — 사이드바 "N일 보관" 표기용.
    retention_days: int | None = None


class TrashRestoreRequest(BaseModel):
    trash_name: str  # the unique name in .trash/


class SearchHit(BaseModel):
    """검색 결과 한 줄. FileItem 에 없는 건 parent/score/snippet/ext."""
    name: str
    path: str
    parent: str                      # 들어있는 폴더(바로 이동할 수 있게)
    is_dir: bool
    size: int
    modified_at: datetime
    mime_type: str | None = None
    ext: str = ""
    score: float = 0
    snippet: str | None = None       # 본문에서 걸린 부분


class SearchResponse(BaseModel):
    query: str
    total: int
    items: list[SearchHit]
