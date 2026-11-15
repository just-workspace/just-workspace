import re
from datetime import datetime

from app.auth import password_policy
from pydantic import BaseModel, field_validator, Field


class UserResponse(BaseModel):
    id: str
    username: str
    display_name: str | None
    email: str | None
    # 주사용(default) 메일계정 주소 — IMAP클라/Exchange 외부연동 시 표출용. 없으면 email.
    primary_email: str | None = None
    avatar_url: str | None
    recovery_email: str | None
    is_admin: bool
    has_2fa: bool = False
    last_login_at: datetime | None
    # 마지막 비밀번호 변경 시각 — 프로필 보안 "마지막 변경 N개월 전" 표시용
    password_changed_at: datetime | None = None
    # 관리자 정책상 2단계 인증 필수인데 아직 등록 전 — /me 에서만 채운다
    totp_setup_required: bool = False

    model_config = {"from_attributes": True}

    @classmethod
    def from_user(cls, user) -> "UserResponse":
        return cls(
            id=user.id,
            username=user.username,
            display_name=user.display_name,
            email=user.email,
            avatar_url=user.avatar_url,
            recovery_email=user.recovery_email,
            is_admin=user.is_admin,
            has_2fa=bool(user.totp_secret),
            last_login_at=user.last_login_at,
            password_changed_at=getattr(user, "password_changed_at", None),
        )


class LoginRequest(BaseModel):
    username: str
    password: str = Field(..., max_length=password_policy.MAX_LENGTH)
    remember_me: bool = False


class RegisterRequest(BaseModel):
    username: str
    password: str = Field(..., max_length=password_policy.MAX_LENGTH)
    display_name: str
    recovery_email: str
    # 관리자 초대 링크(/register?invite=…)로 왔으면 그 토큰 — 가입 방식과 상관없이 바로 승인
    invite_token: str | None = Field(default=None, max_length=128)

    @field_validator("username")
    @classmethod
    def validate_username(cls, v: str) -> str:
        v = v.strip().lower()
        if not re.match(r"^[a-z0-9][a-z0-9.\-]{1,28}[a-z0-9]$", v):
            raise ValueError(
                "사용자명은 영문 소문자, 숫자, 점(.), 하이픈(-)만 사용 가능하며 3~30자여야 합니다"
            )
        if ".." in v or "--" in v:
            raise ValueError("연속된 점이나 하이픈은 사용할 수 없습니다")
        return v

    @field_validator("password")
    @classmethod
    def validate_password(cls, v: str, info) -> str:
        # username 이 먼저 선언돼 있어 info.data 로 참조 가능 → 문맥 기반 추측 차단
        password_policy.validate(v, info.data.get("username"))
        return password_policy.normalize(v)

    @field_validator("recovery_email")
    @classmethod
    def validate_recovery_email(cls, v: str) -> str:
        v = v.strip().lower()
        # Domain-specific recovery email validation is handled by frontend
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("올바른 이메일 주소를 입력해주세요")
        return v

    @field_validator("display_name")
    @classmethod
    def validate_display_name(cls, v: str) -> str:
        v = v.strip()
        if not v or len(v) > 100:
            raise ValueError("표시 이름은 1~100자여야 합니다")
        return v


class ProfileUpdateRequest(BaseModel):
    display_name: str | None = None
    recovery_email: str | None = None

    @field_validator("recovery_email")
    @classmethod
    def validate_recovery_email(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.strip().lower()
        # Domain-specific recovery email validation is handled by frontend
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("올바른 이메일 주소를 입력해주세요")
        return v


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(..., max_length=password_policy.MAX_LENGTH)
    new_password: str = Field(..., max_length=password_policy.MAX_LENGTH)

    @field_validator("new_password")
    @classmethod
    def validate_new_password(cls, v: str) -> str:
        password_policy.validate(v)
        return password_policy.normalize(v)


class ResendVerificationRequest(BaseModel):
    username: str


class ForgotPasswordRequest(BaseModel):
    username: str


class ResetPasswordRequest(BaseModel):
    token: str = Field(..., max_length=512)
    new_password: str = Field(..., max_length=password_policy.MAX_LENGTH)

    @field_validator("new_password")
    @classmethod
    def validate_new_password(cls, v: str) -> str:
        password_policy.validate(v)
        return password_policy.normalize(v)


# ── 2FA (TOTP) schemas ──────────────────────────────────────


class TwoFactorEnableRequest(BaseModel):
    secret: str
    code: str


class TwoFactorDisableRequest(BaseModel):
    code: str


class TwoFactorVerifyRequest(BaseModel):
    temp_token: str
    code: str
