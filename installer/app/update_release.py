"""업데이트 — 채널을 수신·검증하고 수행할 작업을 결정한다.

검증 코드는 복제하지 않는다. 릴리스 도구(`release/jwrelease`)의 `semver`·`model`·`verify`·`bundle` 을
그대로 사용한다 — 이미지에는 빌드 시 `/app/jwrelease` 로 복사되며, 개발·테스트에서는 리포의 `release/` 에서 읽는다.

채널 서버에는 **어떤 정보도 송신하지 않는다**: 정적 파일을 GET 할 뿐이며 식별자·버전·통계를 포함하지 않는다.

설정값(환경변수, 이미지 빌드 인자로 기본값을 내장한다):

| 이름 | 의미 | 기본 |
|---|---|---|
| `JW_UPDATE_CHANNEL_URL` | 채널 파일·manifest 의 기준 주소. 설치 후 `jw update-channel <주소>` 로 지정한 값(상태 폴더의 `update/channel-url`)이 있으면 해당 값이 우선한다 | 릴리스 도구의 `channel_base_url` |
| `JW_UPDATE_PUBKEY_DIR` | 이미지에 내장한 공개 키 폴더(`*.pub`) | `/app/keys` |
| `JW_UPDATE_OFFLINE_URL` | 오프라인 번들을 수신하는 주소 템플릿(`{version}`·`{filename}`) | 릴리스 도구의 `download_url_template` |

공개 키는 최대 2개(현재·다음)이다. 상태 폴더의 `update/keys/*.pub` 가 있으면 그것을 사용하고, 없으면 이미지에 내장한 것을
사용한다. 하나도 없으면 업데이트 확인은 `unconfigured` 를 반환한다.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

try:
    import jwrelease  # noqa: F401 — 이미지: /app/jwrelease
except ImportError:  # 개발·테스트: 리포의 release/ 에서 로드 로드
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "release"))
    import jwrelease  # noqa: F401

from jwrelease import bundle as jwbundle  # noqa: E402
from jwrelease import semver, verify  # noqa: E402
from jwrelease.config import Settings as ReleaseSettings  # noqa: E402
from jwrelease.model import Channel, FormatError, Manifest, ReleaseEntry, channel_rel_path, parse_time  # noqa: E402

__all__ = ["jwbundle", "semver", "verify", "Channel", "Manifest", "ReleaseEntry", "FormatError", "parse_time"]

MIN_AGE_DAYS = 3
MAX_KEYS = verify.MAX_PUBLIC_KEYS
FETCH_TIMEOUT = 20.0
FETCH_LIMIT = 8 * 1024 * 1024      # 채널 파일·manifest 의 상한(정상 파일은 수십 KB)
SIG = ".sig"


CHANNEL_URL_FILE = "update/channel-url"     # 상태 폴더 기준 — `jw update-channel <주소>` 가 기록한다


def channel_url_override(state_dir: Path) -> str | None:
    """설치 후 `jw update-channel` 로 지정한 채널 주소(없으면 None)."""
    try:
        text = (state_dir / CHANNEL_URL_FILE).read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text.rstrip("/") or None


def channel_base_url(state_dir: Path | None = None) -> str:
    """채널 파일의 기준 주소 — 설치 후 지정한 값 → 환경변수 → 릴리스 도구의 기본값."""
    override = channel_url_override(state_dir) if state_dir is not None else None
    return override or (os.environ.get("JW_UPDATE_CHANNEL_URL") or ReleaseSettings().channel_base_url).rstrip("/")


def offline_download_url(version: str) -> str | None:
    template = os.environ.get("JW_UPDATE_OFFLINE_URL")
    if template is None:
        template = ReleaseSettings().download_url_template
    if not template:
        return None
    try:
        return template.format(version=version, filename=jwbundle.bundle_filename(version))
    except (KeyError, IndexError, ValueError):
        return None


def valid_source_url(url: str | None) -> str:
    """소스 주소로 유효한 값이면 그대로, 아니면 빈 문자열 — http(s) 주소, 공백·따옴표·꺾쇠 없음, 2000자 이하."""
    url = (url or "").strip()
    ok = url.lower().startswith(("https://", "http://")) and len(url) <= 2000 \
        and not any(ch.isspace() or ord(ch) < 32 or ch in "\"'<>" for ch in url)
    return url if ok else ""


def source_url_override() -> str:
    """설치 관리자에 지정한 소스 주소(`-e JW_SOURCE_URL=…`) — http(s) 주소가 아니면 빈 문자열(= 기본값 사용)."""
    return valid_source_url(os.environ.get("JW_SOURCE_URL"))


def source_url() -> str:
    """본 제품의 소스 위치 — 화면의 "소스 코드" 링크. 수정하여 서비스하는 운영자는 `JW_SOURCE_URL` 로 변경한다."""
    return source_url_override() or ReleaseSettings().source_repo_url


def utc_iso(t: datetime) -> str:
    return t.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def version_channel(version: str) -> str:
    return "beta" if semver.is_beta(version) else "stable"


# ─── 공개 키 ───


def key_files(state_dir: Path) -> list[Path]:
    """사용할 공개 키 파일 — 상태 폴더에 있으면 그것만, 없으면 이미지에 내장한 것. 이름순, 최대 2개."""
    for folder in (state_dir / "update" / "keys", Path(os.environ.get("JW_UPDATE_PUBKEY_DIR") or "/app/keys")):
        try:
            found = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix in (".pub", ".pem"))
        except OSError:
            found = []
        if found:
            return found[:MAX_KEYS]
    return []


def load_keys(state_dir: Path) -> list:
    """공개 키(0~2개). 읽을 수 없는 파일이 있으면 `verify.VerifyError`."""
    files = key_files(state_dir)
    if not files:
        return []
    return verify.load_public_keys([p.read_bytes() for p in files])


# ─── 수신 ───


class FetchError(Exception):
    pass


def http_fetch(url: str) -> bytes:
    """정적 파일 하나를 수신한다. 쿠키·식별자를 포함하지 않으며, 리다이렉트 응답은 따르지 않는다."""
    import httpx

    try:
        with httpx.Client(timeout=FETCH_TIMEOUT, follow_redirects=False,
                          headers={"User-Agent": "just-workspace-installer", "Accept": "*/*"}) as client:
            with client.stream("GET", url) as r:
                if r.status_code != 200:
                    raise FetchError(f"HTTP {r.status_code}")
                chunks, size = [], 0
                for chunk in r.iter_bytes():
                    size += len(chunk)
                    if size > FETCH_LIMIT:
                        raise FetchError("too large")
                    chunks.append(chunk)
                return b"".join(chunks)
    except httpx.HTTPError as e:
        raise FetchError(type(e).__name__) from None


# ─── 확인 ───


VERIFY_KINDS = {
    verify.SignatureError: "signature", verify.ExpiredError: "expired", verify.RollbackError: "rollback",
    verify.HashMismatchError: "hash", verify.ContentError: "content", verify.UpgradeError: "upgrade",
}


def verify_kind(e: Exception) -> str:
    for cls, name in VERIFY_KINDS.items():
        if isinstance(e, cls):
            return name
    return "invalid"


class CheckError(Exception):
    """확인 실패 — code 는 계약의 `check.error.code`."""

    def __init__(self, code: str, detail: str = "", kind: str = ""):
        super().__init__(code)
        self.code, self.detail, self.kind = code, detail, kind

    def as_dict(self) -> dict:
        out = {"code": self.code, "detail": self.detail}
        if self.kind:
            out["kind"] = self.kind
        return out


@dataclass
class CheckResult:
    channel: Channel
    plan: verify.UpdatePlan
    manifests: dict[str, tuple[bytes, bytes]]      # 경로의 버전 → (manifest 바이트, 서명)


def check_channel(*, current: str, channel_name: str, keys: list, last_sequence: int | None, now: datetime,
                  fetch: Callable[[str], bytes] = http_fetch, base_url: str | None = None) -> CheckResult:
    """채널을 수신하여 검증하고(서명 → 형식 → 만료 → 순번) 계획을 수립한다. 경로상의 manifest 도 수신하여 검증한다."""
    if not keys:
        raise CheckError("unconfigured")
    base = (base_url or channel_base_url()).rstrip("/")
    rel = channel_rel_path(channel_name)
    try:
        data = fetch(f"{base}/{rel}")
        sig = fetch(f"{base}/{rel}{SIG}")
    except FetchError as e:
        raise CheckError("channel_unreachable", str(e)) from None
    try:
        channel = verify.verify_channel(data, sig, keys, now=now, expected_channel=channel_name,
                                        last_sequence=last_sequence)
    except verify.VerifyError as e:
        raise CheckError("channel_invalid", str(e), verify_kind(e)) from None
    plan = verify.plan_update(current, channel)
    manifests: dict[str, tuple[bytes, bytes]] = {}
    for version in plan.path:
        entry = channel.find(version)
        try:
            raw = fetch(f"{base}/{entry.manifest_path}")
            raw_sig = fetch(f"{base}/{entry.manifest_path}{SIG}")
        except FetchError as e:
            raise CheckError("channel_unreachable", f"{version}: {e}") from None
        try:
            verify.verify_manifest(raw, raw_sig, keys, entry)
        except verify.VerifyError as e:
            raise CheckError("manifest_invalid", str(e), verify_kind(e)) from None
        manifests[version] = (raw, raw_sig)
    return CheckResult(channel, plan, manifests)


def resume_from(current: str) -> str:
    """Stable 로 복귀하여 대기할 때 수신을 재개하는 최저 버전."""
    return semver.stable_of(current) if semver.is_beta(current) else current


def auto_eligible_at(published: str) -> str:
    return utc_iso(parse_time(published) + timedelta(days=MIN_AGE_DAYS))


def in_window(start: str, end: str, local_minutes: int) -> bool:
    """서버 시간(자정 기준 분)이 적용 시간대 내인지 판정. start > end 이면 자정을 넘는 시간대."""
    a, b = _minutes(start), _minutes(end)
    if a == b:
        return False
    if a < b:
        return a <= local_minutes < b
    return local_minutes >= a or local_minutes < b


def _minutes(hhmm: str) -> int:
    h, _, m = hhmm.partition(":")
    return int(h) * 60 + int(m)
