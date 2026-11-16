from datetime import datetime

from pydantic import BaseModel


class FileItem(BaseModel):
    name: str
    path: str  # virtual path (my/... or shared/...)
    is_dir: bool
    size: int = 0
    modified_at: datetime | None = None
    mime_type: str | None = None
    # 파일 전용. 크기+mtime(ns) 기반이며 다운로드 응답 ETag 와 동일한 값이므로 클라이언트가
    # 목록만으로 미변경 파일을 판별할 수 있다. 디렉터리 ETag 는 미지원이다.
    etag: str | None = None
    # 소유자({id, name}, 미확인 시 null) · 본인 즐겨찾기 여부
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
    paths: list[str]  # zip 압축 대상 파일/폴더 virtual paths


class ShareLinkCreate(BaseModel):
    # Office 문서(docx·xlsx·pptx 등)에만 유효. OnlyOffice 공동 편집(app/wopi/share.py).
    can_edit: bool = False
    path: str = ""
    expires_in: str | None = None  # "1h", "1d", "7d", None=unlimited
    one_time: bool = False
    # ── 추가 필드 ──
    paths: list[str] | None = None  # 2개 이상이면 묶음 링크(zip)
    password: str | None = None  # 지정 시 비밀번호 링크
    allow_download: bool = True  # false 면 미리보기만 허용


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
    is_folder: bool = False  # 단일 폴더 링크. 게스트 화면에서 내부 탐색 가능


class ShareLinkListItem(BaseModel):
    id: str
    token: str
    display_name: str
    file_path: str
    expires_at: datetime | None
    max_downloads: int | None
    download_count: int
    created_at: datetime
    # 공동 편집 링크의 주소는 /s/<token>(편집기), 그 외는 /api/files/shared/<token>(다운로드).
    # 목록에서 링크 재복사 시 주소 종류 구분이 필요하여 반환한다(파일 UI 공유 모달).
    can_edit: bool = False
    has_password: bool = False
    allow_download: bool = True
    paths: list[str] = []  # 묶음 링크인 경우 복수
    email_count: int = 0  # 이메일 발송 수신자 수(성공 건만)
    is_folder: bool = False
    # false 면 "내려받기 막음"으로 변경 불가. 단일 파일 링크이면서 미리보기 미지원 형식인 경우(링크가 무효화됨)
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
    message: str | None = None  # 동봉 메시지(선택)


class TrashItem(BaseModel):
    name: str
    original_path: str  # virtual path before deletion
    size: int = 0
    trashed_at: datetime | None = None
    trash_name: str  # unique name in .trash/ (for restore/permanent delete)


class TrashListResponse(BaseModel):
    items: list[TrashItem]
    # 휴지통 자동 삭제 기간(일, 0=자동 삭제 미수행). 관리자 설정값이며 사이드바 "N일 보관" 표기에 사용.
    retention_days: int | None = None


class TrashRestoreRequest(BaseModel):
    trash_name: str  # the unique name in .trash/


class SearchHit(BaseModel):
    """검색 결과 1건. FileItem 에 없는 필드는 parent/score/snippet/ext."""
    name: str
    path: str
    parent: str                      # 상위 폴더(즉시 이동용)
    is_dir: bool
    size: int
    modified_at: datetime
    mime_type: str | None = None
    ext: str = ""
    score: float = 0
    snippet: str | None = None       # 본문 내 일치 부분


class SearchResponse(BaseModel):
    query: str
    total: int
    items: list[SearchHit]
