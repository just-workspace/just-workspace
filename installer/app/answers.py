"""답변(Answers) — 마법사 상태이자 답변 파일의 형식.

- 구조(타입·고를 수 있는 값)는 pydantic 모델이 지킨다. 모르는 항목은 거부한다(오타를 조용히 넘기지 않는다).
- 뜻(조합·필수·메모리)은 `validate()` 가 **필드별 오류 목록**으로 돌려준다. 문구는 화면이 가진다 — 여기서는
  `{"field": "access.cert", "code": "cert_auto_behind_proxy", "vars": {...}}` 처럼 키와 값만 낸다.
- 비밀번호·API 키(`SECRET_FIELDS`)는 저장할 때 따로 떼어 둔다. 내려받는 답변 파일에는 들어가지 않는다.
- 꺼진 구역의 항목은 검사하지 않고, 렌더링도 쓰지 않는다.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app import validators as v
from app.catalog import Catalog

ANSWERS_VERSION = 1
DEFAULT_SUBNET = "172.28.0.0/24"
ADMIN_PASSWORD_MIN = 12
QUICK_PRESET = "collab"
FALLBACK_PRESET = "minimal"

# backend/app/ai/providers.py 의 DEFAULT_BASE 와 같은 목록(화면에서 고르는 순서)
AI_PROVIDERS = ("anthropic", "openai", "gemini", "ollama", "compatible")
AI_KEYLESS = ("ollama", "compatible")        # 키 없이도 되는 제공자(직접 운영하는 서버)
AI_NEEDS_BASE_URL = ("compatible",)

# (구역, 항목) — 저장할 때 분리하고 내려받기에서 뺀다
SECRET_FIELDS: tuple[tuple[str, str], ...] = (
    ("admin", "password"),
    ("mail", "password"),
    ("ai", "api_key"),
)


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Access(_Model):
    domain: str = ""
    network: Literal["direct", "router", "proxy"] = "direct"
    proxy_addresses: list[str] = Field(default_factory=list)
    cert: Literal["auto", "upload", "temporary", "proxy"] = "auto"
    acme_email: str | None = None        # 비우면 admin@<도메인>
    # 답변 파일로 무인 설치할 때의 인증서 파일(컨테이너 안 /data 아래 경로). 화면에서는 올린 파일을 쓴다.
    cert_path: str | None = None
    key_path: str | None = None
    ca_path: str | None = None            # (선택) 사설 CA 가 내준 인증서일 때 그 CA 인증서 — 인증서 파일에 체인이 없을 때만 필요하다


class Storage(_Model):
    kind: Literal["local", "nfs"] = "local"
    path: str | None = None              # local: 호스트에 이미 있는 폴더(비우면 도커 볼륨)
    server: str | None = None            # nfs
    export: str | None = None            # nfs


class Mail(_Model):
    kind: Literal["builtin", "external"] = "builtin"
    mail_domain: str | None = None       # builtin
    host: str | None = None              # external
    port: int = 587
    security: Literal["starttls", "ssl", "none"] = "starttls"
    username: str | None = None
    password: str | None = None
    from_address: str | None = None      # 비우면 username(주소 꼴일 때) 또는 noreply@<도메인>


class Meetings(_Model):
    public_ip: str | None = None
    turn: bool = True
    lossless_audio: bool = False


class AI(_Model):
    mode: Literal["later", "provider"] = "later"
    provider: str | None = None
    model: str | None = None
    base_url: str | None = None
    api_key: str | None = None


class Git(_Model):
    version: str = "verified"            # verified | latest | <이미지 태그>


class Advanced(_Model):
    subnet: str = DEFAULT_SUBNET


class Admin(_Model):
    name: str = ""
    username: str = ""
    password: str | None = None


class Restore(_Model):
    """`mode: restore` 의 답변 파일에서만 쓴다(화면은 백업을 올리거나 경로를 알려 준다)."""

    path: str | None = None              # 서버(호스트)에 있는 백업 파일(.jwbak)·폴더의 절대 경로
    password_file: str | None = None     # 설정이 암호로 보호된 백업 — 암호가 든 파일(컨테이너 안 /data 아래)


class Answers(_Model):
    version: int = ANSWERS_VERSION
    mode: Literal["new", "quick", "restore"] = "new"
    access: Access = Field(default_factory=Access)
    storage: Storage = Field(default_factory=Storage)
    preset: str | None = None            # zones 를 비워 두면 이 묶음을 쓴다
    zones: list[str] | None = None       # 켤 구역 id
    addons: list[str] = Field(default_factory=list)
    mail: Mail = Field(default_factory=Mail)
    meetings: Meetings = Field(default_factory=Meetings)
    ai: AI = Field(default_factory=AI)
    git: Git = Field(default_factory=Git)
    advanced: Advanced = Field(default_factory=Advanced)
    admin: Admin = Field(default_factory=Admin)
    restore: Restore = Field(default_factory=Restore)


# ─── 오류 ───


@dataclass(frozen=True)
class FieldError:
    field: str
    code: str
    vars: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {"field": self.field, "code": self.code, "vars": self.vars}


class StructureError(ValueError):
    """모양이 맞지 않는 답변(타입·모르는 항목·고를 수 없는 값)."""

    def __init__(self, errors: list[FieldError]):
        super().__init__(", ".join(f"{e.field}: {e.code}" for e in errors))
        self.errors = errors


def load(data: dict) -> Answers:
    """dict → Answers. 모양이 틀리면 `StructureError`."""
    if not isinstance(data, dict):
        raise StructureError([FieldError("", "not_an_object")])
    version = data.get("version", ANSWERS_VERSION)
    if version != ANSWERS_VERSION:
        raise StructureError([FieldError("version", "version_unsupported",
                                         {"got": version, "supported": ANSWERS_VERSION})])
    try:
        return Answers.model_validate(data)
    except ValidationError as e:
        errors = []
        for item in e.errors():
            loc = ".".join(str(p) for p in item["loc"])
            code = {"extra_forbidden": "unknown_field", "missing": "required"}.get(item["type"], "invalid_value")
            errors.append(FieldError(loc, code, {"type": item["type"]}))
        raise StructureError(errors) from None


def merge_patch(current: dict, patch: dict) -> dict:
    """부분 저장 — 사전은 겹쳐 합치고 나머지는 바꿔 끼운다. `null` 은 그 항목을 기본값으로 돌린다."""
    out = dict(current)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = merge_patch(out[key], value)
        elif value is None:
            out.pop(key, None)
        else:
            out[key] = value
    return out


# ─── 비밀 분리 ───


def split(answers: Answers) -> tuple[dict, dict]:
    """(비밀을 뺀 답변, 비밀) — 비밀은 `{"admin.password": "…"}` 꼴."""
    public = answers.model_dump(mode="json")
    secrets: dict[str, str] = {}
    for section, name in SECRET_FIELDS:
        value = public.get(section, {}).pop(name, None)
        if value:
            secrets[f"{section}.{name}"] = value
    return public, secrets


def join(public: dict, secrets: dict) -> Answers:
    data = {k: (dict(val) if isinstance(val, dict) else val) for k, val in public.items()}
    for section, name in SECRET_FIELDS:
        value = secrets.get(f"{section}.{name}")
        if value:
            data.setdefault(section, {})[name] = value
    return load(data)


def secrets_present(secrets: dict) -> dict[str, bool]:
    return {f"{s}.{n}": bool(secrets.get(f"{s}.{n}")) for s, n in SECRET_FIELDS}


# ─── 구역 선택 ───


def selected_zones(answers: Answers, catalog: Catalog) -> list[str]:
    """켤 구역과 부가 구역(선언 순서). zones 가 없으면 preset, 그것도 없으면 최소 묶음."""
    if answers.zones is not None:
        base = list(answers.zones)
    else:
        base = catalog.presets.get(answers.preset or FALLBACK_PRESET, [])
    return catalog.ordered([*base, *answers.addons])


@dataclass
class Facts:
    """검증·렌더링에 쓰는 감지값. 모르면 None."""

    memory_mb: int | None = None
    cpus: int | None = None
    public_ip: str | None = None
    dns_status: str | None = None          # match | mismatch | unknown
    cert_issue_failed: bool = False        # 인증서 자동 발급이 실패한 적이 있다
    upload_cert_ok: bool = False           # 올린 인증서 파일이 검증을 통과했다
    site_ca: bool = False                  # 올린 인증서의 발급 CA 를 안다(체인이 함께 왔거나 CA 를 따로 올렸다) — 코드 저장소·backend 가 그것을 믿게 한다
    source_url: str | None = None          # 화면의 "소스 코드" 링크로 넘길 주소 — 설치 관리자에 준 JW_SOURCE_URL 을 기억해 둔 것(render.settle_source_url)
    proxy_lan_ip: str | None = None
    host_address: str | None = None        # 이 서버가 밖으로 나갈 때 쓰는 주소(사전 점검이 감지)
    gateway: str | None = None             # 이 서버의 기본 게이트웨이(사전 점검이 감지)

    def as_dict(self) -> dict:
        return dict(self.__dict__)


def resolve_quick(answers: Answers, catalog: Catalog, facts: Facts) -> tuple[Answers, list[dict]]:
    """빠른 설치의 기본 묶음을 정한다 — 협업 묶음, 메모리가 모자라면 최소 묶음으로 내리고 사유를 남긴다."""
    notes: list[dict] = []
    if answers.mode != "quick" or answers.zones is not None:
        return answers, notes
    preset = answers.preset or QUICK_PRESET
    if facts.memory_mb:
        verdict = catalog.judge([*catalog.presets.get(preset, []), *answers.addons], facts.memory_mb)
        if not verdict.ok and preset != FALLBACK_PRESET:
            notes.append({"key": "quick_downgraded", "vars": {
                "from": preset, "to": FALLBACK_PRESET,
                "need_mb": verdict.need_mb, "have_mb": verdict.have_mb}})
            preset = FALLBACK_PRESET
    resolved = answers.model_copy(update={"preset": preset, "zones": list(catalog.presets.get(preset, []))})
    return resolved, notes


# ─── 뜻 검증 ───


def _check(errors: list[FieldError], path: str, fn, value, *, required: bool) -> None:
    if value in (None, ""):
        if required:
            errors.append(FieldError(path, "required"))
        return
    try:
        fn(value)
    except v.Invalid as e:
        errors.append(FieldError(path, e.code, e.vars))


def validate(answers: Answers, catalog: Catalog, facts: Facts | None = None, *, final: bool = True) -> list[FieldError]:
    """필드별 오류 목록. `final=False`(부분 저장)면 빈 필수 항목은 넘어가고 적힌 값만 본다."""
    facts = facts or Facts()
    errors: list[FieldError] = []
    need = final
    # 복원: 구역·메일·관리자는 백업에서 온다 — 관리자 계정은 만들지 않으므로 묻지 않는다
    restoring = answers.mode == "restore"

    # ── 접속 ──
    a = answers.access
    _check(errors, "access.domain", v.address, a.domain, required=need)
    domain_is_ip = bool(a.domain) and v.is_ip(a.domain)
    if a.network == "proxy":
        if a.cert != "proxy":
            errors.append(FieldError("access.cert", "cert_not_proxy_behind_proxy", {"cert": a.cert}))
        if not a.proxy_addresses:
            if need:
                errors.append(FieldError("access.proxy_addresses", "required"))
        for i, item in enumerate(a.proxy_addresses):
            _check(errors, f"access.proxy_addresses.{i}", v.cidr, item, required=True)
    else:
        if a.cert == "proxy":
            errors.append(FieldError("access.cert", "cert_proxy_without_proxy", {"network": a.network}))
        if a.cert == "auto" and domain_is_ip:
            errors.append(FieldError("access.cert", "cert_auto_needs_domain"))
        if a.cert == "temporary" and not domain_is_ip:
            allowed = facts.cert_issue_failed or facts.dns_status in ("mismatch", "unknown")
            if facts.dns_status is None and not facts.cert_issue_failed:
                if need:
                    errors.append(FieldError("access.cert", "cert_temporary_needs_dns_check"))
            elif not allowed:
                errors.append(FieldError("access.cert", "cert_temporary_not_allowed"))
        if a.cert == "upload" and need and not (facts.upload_cert_ok or (a.cert_path and a.key_path)):
            errors.append(FieldError("access.cert", "cert_upload_missing"))
    if a.acme_email:
        _check(errors, "access.acme_email", v.email, a.acme_email, required=False)
    for name in ("cert_path", "key_path", "ca_path"):
        value = getattr(a, name)
        if value and not (value.startswith("/data/") and ".." not in value.split("/")):
            errors.append(FieldError(f"access.{name}", "path_outside_data"))
    if answers.restore.path:
        _check(errors, "restore.path", v.host_path, answers.restore.path, required=False)
    pw_file = answers.restore.password_file
    if pw_file and not (pw_file.startswith("/data/") and ".." not in pw_file.split("/")):
        errors.append(FieldError("restore.password_file", "path_outside_data"))

    # ── 저장소 ──
    s = answers.storage
    if s.kind == "local":
        _check(errors, "storage.path", v.host_path, s.path, required=False)
    else:
        _check(errors, "storage.server", v.hostname, s.server, required=need)
        _check(errors, "storage.export", v.nfs_export, s.export, required=need)

    # ── 구역 ──
    if answers.preset is not None and answers.preset not in catalog.presets:
        errors.append(FieldError("preset", "preset_unknown", {"preset": answers.preset}))
    for i, zone_id in enumerate(answers.zones or []):
        if zone_id not in catalog.zone_ids:
            errors.append(FieldError(f"zones.{i}", "zone_unknown", {"zone": zone_id}))
    for i, zone_id in enumerate(answers.addons):
        if zone_id not in catalog.addon_ids:
            errors.append(FieldError(f"addons.{i}", "zone_unknown", {"zone": zone_id}))
    chosen = selected_zones(answers, catalog)
    for zone_id in chosen:
        for req in catalog.get(zone_id).get("requires", []):
            if req not in chosen:
                errors.append(FieldError("zones", "zone_requires", {"zone": zone_id, "requires": req}))
    if facts.memory_mb:
        verdict = catalog.judge(chosen, facts.memory_mb)
        if verdict.below_minimum:
            errors.append(FieldError("zones", "memory_below_minimum", verdict.as_dict()))
        elif not verdict.ok:
            errors.append(FieldError("zones", "memory_insufficient", verdict.as_dict()))

    # ── 구역별 항목(켜진 구역만) ──
    if "mail" in chosen:
        m = answers.mail
        if m.kind == "builtin":
            _check(errors, "mail.mail_domain", v.domain, m.mail_domain, required=need)
        else:
            _check(errors, "mail.host", v.hostname, m.host, required=need)
            _check(errors, "mail.port", v.port, m.port, required=True)
            _check(errors, "mail.username", v.single_line, m.username, required=need)
            if need and not m.password:
                errors.append(FieldError("mail.password", "required"))
            if m.password and any(ch in m.password for ch in "\r\n\x00"):
                errors.append(FieldError("mail.password", "text_invalid"))
            _check(errors, "mail.from_address", v.email, m.from_address, required=False)

    if "meetings" in chosen:
        mt = answers.meetings
        _check(errors, "meetings.public_ip", v.ipv4, mt.public_ip,
               required=need and not facts.public_ip and not restoring)
        if mt.turn and domain_is_ip:
            errors.append(FieldError("meetings.turn", "turn_needs_domain"))
        if mt.lossless_audio and "chat" not in chosen:
            errors.append(FieldError("meetings.lossless_audio", "lossless_needs_chat"))

    if "ai" in chosen and answers.ai.mode == "provider":
        ai = answers.ai
        if not ai.provider:
            errors.append(FieldError("ai.provider", "required"))
        elif ai.provider not in AI_PROVIDERS:
            errors.append(FieldError("ai.provider", "provider_unknown", {"provider": ai.provider}))
        else:
            _check(errors, "ai.model", v.model_name, ai.model, required=False)   # 모델은 나중에 관리 화면에서 골라도 된다
            _check(errors, "ai.base_url", v.http_url, ai.base_url, required=need and ai.provider in AI_NEEDS_BASE_URL)
            if need and not ai.api_key and ai.provider not in AI_KEYLESS:
                errors.append(FieldError("ai.api_key", "required"))
            if ai.api_key and any(ch in ai.api_key for ch in "\r\n\x00 "):
                errors.append(FieldError("ai.api_key", "text_invalid"))

    if "git" in chosen and answers.git.version not in ("verified", "latest"):
        _check(errors, "git.version", v.image_tag, answers.git.version, required=True)

    # ── 고급 · 관리자 ──
    _check(errors, "advanced.subnet", v.subnet24, answers.advanced.subnet, required=True)
    ad = answers.admin
    _check(errors, "admin.name", v.single_line, ad.name, required=need and not restoring)
    _check(errors, "admin.username", v.username, ad.username, required=need and not restoring)
    if restoring:
        pass
    elif ad.password is None or ad.password == "":
        if need:
            errors.append(FieldError("admin.password", "required"))
    elif len(ad.password) < ADMIN_PASSWORD_MIN:
        errors.append(FieldError("admin.password", "password_too_short", {"min": ADMIN_PASSWORD_MIN}))
    elif any(ch in ad.password for ch in "\r\n\x00"):
        errors.append(FieldError("admin.password", "text_invalid"))

    return errors
