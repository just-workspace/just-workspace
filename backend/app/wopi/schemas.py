"""WOPI Pydantic schemas."""

from pydantic import BaseModel


class EditorOpenRequest(BaseModel):
    path: str  # virtual path (e.g. "my/docs/report.docx")
    editor: str = "auto"  # 구 API 호환용. 현재는 OnlyOffice 단일 구성이므로 무시됨.


class EditorOpenResponse(BaseModel):
    editor: str
    editor_url: str  # iframe src
    token: str  # WOPI access token
    token_ttl: int
    file_name: str
    wopi_src: str  # WOPI file info URL


class WopiFileInfo(BaseModel):
    """WOPI CheckFileInfo response (subset of spec)."""
    BaseFileName: str
    Size: int
    OwnerId: str
    UserId: str
    UserFriendlyName: str
    Version: str
    UserCanWrite: bool
    UserCanNotWriteRelative: bool = True
    SupportsLocks: bool = True
    SupportsGetLock: bool = True
    SupportsUpdate: bool = True
    PostMessageOrigin: str = ""
    # OnlyOffice specific
    HostEditUrl: str = ""
    HostViewUrl: str = ""


class LockStatusResponse(BaseModel):
    locked: bool
    user_id: str | None = None
    user_name: str | None = None
    editor: str | None = None
