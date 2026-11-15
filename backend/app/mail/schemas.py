"""Mail API schemas."""

from pydantic import BaseModel, Field


class EmailAddress(BaseModel):
    name: str | None = None
    email: str


class Mailbox(BaseModel):
    id: str
    name: str
    role: str | None = None  # inbox, sent, drafts, trash, junk, archive
    unread_count: int = 0
    total_count: int = 0
    sort_order: int = 0


class MailboxListResponse(BaseModel):
    mailboxes: list[Mailbox]


class Attachment(BaseModel):
    blob_id: str
    name: str | None = None
    type: str | None = None
    size: int = 0


class MessageSummary(BaseModel):
    id: str
    thread_id: str | None = None
    mailbox_ids: list[str] = []
    from_: list[EmailAddress] = []
    to: list[EmailAddress] = []
    subject: str | None = None
    preview: str | None = None
    received_at: str | None = None
    is_unread: bool = False
    is_flagged: bool = False
    has_attachment: bool = False
    # ── 추가 필드 ──
    labels: list[str] = []  # IMAP 키워드 라벨
    thread_count: int | None = None  # 서버 THREAD 지원 시 이 메일함 안 스레드 메일 수

    model_config = {"populate_by_name": True}


class ThreadResponse(BaseModel):
    thread_id: str | None = None
    messages: list[MessageSummary] = []


class LabelListResponse(BaseModel):
    labels: list[str] = []
    supported: bool = False  # 서버가 새 키워드를 허용하는지(PERMANENTFLAGS \*)


class MessageListResponse(BaseModel):
    messages: list[MessageSummary]
    total: int = 0
    page: int = 0
    limit: int = 50


class MessageDetail(BaseModel):
    id: str
    thread_id: str | None = None
    mailbox_ids: list[str] = []
    from_: list[EmailAddress] = []
    to: list[EmailAddress] = []
    cc: list[EmailAddress] = []
    bcc: list[EmailAddress] = []
    reply_to: list[EmailAddress] = []
    subject: str | None = None
    text_body: str | None = None
    html_body: str | None = None
    preview: str | None = None
    received_at: str | None = None
    is_unread: bool = False
    is_flagged: bool = False
    attachments: list[Attachment] = []
    disposition_notification_to: str | None = None
    mdn_sent: bool = False

    model_config = {"populate_by_name": True}


class MessageUpdateRequest(BaseModel):
    is_unread: bool | None = None
    is_flagged: bool | None = None
    mailbox_ids: list[str] | None = None  # move to mailbox
    add_labels: list[str] | None = None  # IMAP 키워드로 붙인다
    remove_labels: list[str] | None = None


class AttachmentRef(BaseModel):
    blobId: str
    name: str
    type: str = "application/octet-stream"
    size: int = 0


class SendMessageRequest(BaseModel):
    account_id: str | None = None  # which account to send from
    from_name: str | None = None  # custom display name
    to: list[EmailAddress]
    cc: list[EmailAddress] = []
    bcc: list[EmailAddress] = []
    subject: str = ""
    text_body: str = ""
    html_body: str | None = None
    in_reply_to: str | None = None  # message id for threading
    references: list[str] = []
    request_read_receipt: bool = False
    attachments: list[AttachmentRef] | None = None
    # ── 추가 필드 ──
    send_at: str | None = None  # ISO. 지금보다 뒤면 예약 발송(응답에 scheduled=true, id)
    # 주면 서버가 서명을 붙인다(본문에 이미 있던 서명 블록은 빼고 하나만)
    signature_id: str | None = None
    # in_reply_to 가 Message-ID 가 아니라 UID 일 때 원문을 찾을 메일함(기본 INBOX)
    reply_mailbox_id: str | None = None
    # 화면 안 AI 답장 초안으로 쓴 메일. 보내기는 사람이 하지만 AI 기본법 표시(X-AI-Generated)를 붙인다
    ai_generated: bool = False


class BulkActionRequest(BaseModel):
    account_id: str | None = None
    message_ids: list[str]
    action: str  # "read", "unread", "star", "unstar", "delete", "move", "spam"
    mailbox_id: str | None = None  # target mailbox for "move"


class MailboxCreateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)


class MailboxRenameRequest(BaseModel):
    old_name: str = Field(..., min_length=1, max_length=100)
    new_name: str = Field(..., min_length=1, max_length=100)


class SignatureCreate(BaseModel):
    name: str = Field(..., max_length=100)
    html_content: str = Field(..., max_length=50000)
    is_default: bool = False


class SignatureUpdate(BaseModel):
    name: str | None = Field(None, max_length=100)
    html_content: str | None = Field(None, max_length=50000)
    is_default: bool | None = None


class SignatureResponse(BaseModel):
    id: str
    name: str
    html_content: str
    is_default: bool
    created_at: str

    model_config = {"from_attributes": True}


# ─── Mail Account schemas ───


class MailAccountCreate(BaseModel):
    display_name: str = Field(..., max_length=100)
    email: str = Field(..., max_length=255)
    protocol: str = "imap"   # imap | pop3 (수신 프로토콜)
    imap_host: str = Field(..., max_length=255)
    imap_port: int = 993
    imap_security: str = "ssl"
    smtp_host: str = Field(..., max_length=255)
    smtp_port: int = 587
    smtp_security: str = "starttls"
    username: str = Field(..., max_length=255)
    password: str = Field(..., max_length=500)
    is_default: bool = False


class MailAccountUpdate(BaseModel):
    display_name: str | None = Field(None, max_length=100)
    email: str | None = Field(None, max_length=255)
    protocol: str | None = None
    imap_host: str | None = Field(None, max_length=255)
    imap_port: int | None = None
    imap_security: str | None = None
    smtp_host: str | None = Field(None, max_length=255)
    smtp_port: int | None = None
    smtp_security: str | None = None
    username: str | None = Field(None, max_length=255)
    password: str | None = Field(None, max_length=500)
    is_default: bool | None = None
    archive_enabled: bool | None = None


class MailAccountResponse(BaseModel):
    id: str
    display_name: str
    email: str
    protocol: str = "imap"
    imap_host: str
    imap_port: int
    imap_security: str
    smtp_host: str
    smtp_port: int
    smtp_security: str
    username: str
    is_default: bool
    archive_enabled: bool = False
    is_builtin: bool = False
    last_sync_at: str | None = None
    sync_error: str | None = None


# ─── Draft schemas ───


class DraftSave(BaseModel):
    id: str | None = None  # if provided, update existing draft
    account_id: str | None = None
    subject: str | None = None
    to: list[EmailAddress] = []
    cc: list[EmailAddress] = []
    bcc: list[EmailAddress] = []
    body_html: str | None = None
    body_text: str | None = None
    signature_id: str | None = None  # 이 초안에 쓸 서명(본문에는 넣지 않는 것을 권장)
    # 워크스페이스 파일 경로(AI 도구). None = 그대로 둠, [] = 비움
    file_attachments: list[str] | None = None


class DraftResponse(BaseModel):
    id: str
    account_id: str | None = None
    subject: str | None = None
    to: list[EmailAddress] = []
    cc: list[EmailAddress] = []
    bcc: list[EmailAddress] = []
    body_html: str | None = None
    body_text: str | None = None
    created_at: str
    updated_at: str
    # ── 서명 이중 부착 방지 ──
    signature_id: str | None = None
    has_signature: bool = False  # 본문에 서명 블록이 이미 들어 있다
    body_html_without_signature: str | None = None  # 이어 쓰기는 이걸로 하면 중복이 안 생긴다
    body_text_without_signature: str | None = None
    # 초안에 붙은 워크스페이스 파일(경로·이름·크기)과, 단건 조회 때 그것을 작성 창 임시 첨부로 바꾼 것
    file_attachments: list[dict] = []
    attachments: list[dict] = []
    attachment_error: str | None = None


class ScheduledMailResponse(BaseModel):
    id: str
    account_id: str | None = None
    subject: str | None = None
    to: list[EmailAddress] = []
    send_at: str
    status: str  # pending | sending | sent | failed | cancelled
    error: str | None = None
    created_at: str
    sent_at: str | None = None


class ScheduledMailUpdate(BaseModel):
    send_at: str
