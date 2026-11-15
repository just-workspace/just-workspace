"""채널·릴리스 목록 검증과 업그레이드 판정 — 설치 관리자가 그대로 가져다 쓰는 모듈.

의존성은 `cryptography` 하나(+ 같은 패키지의 `model`, `semver` — 둘 다 표준 라이브러리만 쓴다).
모든 함수는 순수 함수다: 파일·네트워크·시계를 건드리지 않고, 바이트와 "지금 시각"을 인자로 받는다.

채널 검증 순서(`verify_channel`):
  1. 서명 — 공개 키 1~2개 중 하나로 검증되면 통과(키 교체 기간에는 현재 키와 다음 키를 함께 준다)
  2. 형식 — 서명이 맞은 뒤에만 해석한다
  3. 만료 — `expires` 가 지났으면 거부(옛 채널 파일 재사용 차단)
  4. 순번 — 이전에 받아들인 `sequence` 보다 작으면 거부(롤백 차단)
그 다음 릴리스 하나를 고르면(`plan_update`) manifest 를 받아 `verify_manifest` 로
  5. 해시 — 채널 파일에 적힌 SHA-256 과 일치
  6. 서명
  7. 내용 — 버전·공개 시각·`min_upgrade_from` 이 채널 파일의 줄과 일치
"""

from __future__ import annotations

import base64
import binascii
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from typing import Iterable, Sequence

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

from . import semver
from .model import Channel, FormatError, Manifest, ReleaseEntry, parse_time, sha256_hex

MAX_PUBLIC_KEYS = 2


class VerifyError(Exception):
    """검증 실패(아래 종류의 부모)."""


class SignatureError(VerifyError):
    """서명이 어느 공개 키로도 검증되지 않는다."""


class ExpiredError(VerifyError):
    """채널 파일의 만료 시각이 지났다."""


class RollbackError(VerifyError):
    """채널 파일의 순번이 이전에 본 것보다 작다."""


class HashMismatchError(VerifyError):
    """파일의 SHA-256 이 기대값과 다르다."""


class ContentError(VerifyError):
    """서명은 맞지만 내용이 형식에 맞지 않거나 서로 어긋난다."""


class UpgradeError(VerifyError):
    """그 버전으로 갈 수 없다(다운그레이드, 경로 없음 등)."""


# ── 서명 ─────────────────────────────────────────────────────


def load_public_key(pem: bytes) -> ec.EllipticCurvePublicKey:
    try:
        key = serialization.load_pem_public_key(pem)
    except ValueError as e:
        raise VerifyError(f"공개 키를 읽지 못했다: {e}") from None
    if not isinstance(key, ec.EllipticCurvePublicKey) or not isinstance(key.curve, ec.SECP256R1):
        raise VerifyError("ECDSA P-256 공개 키가 아니다")
    return key


def load_public_keys(pems: Iterable[bytes]) -> list[ec.EllipticCurvePublicKey]:
    """공개 키 PEM 1~2개(현재 + 다음)."""
    keys = [load_public_key(p) for p in pems]
    if not 1 <= len(keys) <= MAX_PUBLIC_KEYS:
        raise VerifyError(f"공개 키는 1~{MAX_PUBLIC_KEYS}개여야 한다(받은 수 {len(keys)})")
    return keys


def decode_signature(signature: bytes | str) -> bytes:
    """`.sig` 파일 내용(base64) → DER 서명. 앞뒤 공백·줄바꿈은 허용한다."""
    raw = signature.encode("ascii", "replace") if isinstance(signature, str) else bytes(signature)
    raw = b"".join(raw.split())
    if not raw:
        raise SignatureError("서명이 비어 있다")
    try:
        return base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        raise SignatureError("서명이 base64 가 아니다") from None


def verify_signature(data: bytes, signature: bytes | str, public_keys: Sequence[ec.EllipticCurvePublicKey]) -> int:
    """어느 한 키로 검증되면 그 키의 순서(0 부터)를 돌려준다. 아니면 SignatureError."""
    if not public_keys:
        raise SignatureError("공개 키가 없다")
    der = decode_signature(signature)
    for index, key in enumerate(public_keys):
        try:
            key.verify(der, data, ec.ECDSA(hashes.SHA256()))
        except InvalidSignature:
            continue
        return index
    raise SignatureError("서명이 맞지 않는다")


# ── 채널·manifest ───────────────────────────────────────────


def verify_channel(
    data: bytes,
    signature: bytes | str,
    public_keys: Sequence[ec.EllipticCurvePublicKey],
    *,
    now: datetime,
    expected_channel: str | None = None,
    last_sequence: int | None = None,
) -> Channel:
    """채널 파일 검증(서명 → 형식 → 만료 → 순번). 통과하면 해석한 채널을 돌려준다.

    `last_sequence` 는 이전에 받아들인 채널 파일의 순번이다. 통과한 뒤에는 돌려받은 채널의
    `sequence` 를 저장해 다음 검증에 넘긴다.
    """
    if now.tzinfo is None:
        raise ValueError("now 에 시간대가 있어야 한다")
    verify_signature(data, signature, public_keys)
    try:
        channel = Channel.from_bytes(data)
    except FormatError as e:
        raise ContentError(str(e)) from None
    if expected_channel is not None and channel.channel != expected_channel:
        raise ContentError(f"다른 채널의 파일이다: {channel.channel}(기대 {expected_channel})")
    if now >= parse_time(channel.expires):
        raise ExpiredError(f"채널 파일이 만료됐다({channel.expires})")
    if last_sequence is not None and channel.sequence < last_sequence:
        raise RollbackError(f"순번이 뒤로 갔다({channel.sequence} < {last_sequence})")
    return channel


def verify_manifest(
    data: bytes,
    signature: bytes | str,
    public_keys: Sequence[ec.EllipticCurvePublicKey],
    entry: ReleaseEntry,
) -> Manifest:
    """manifest 검증(해시 → 서명 → 채널 파일의 줄과 내용 일치)."""
    actual = sha256_hex(data)
    if actual != entry.manifest_sha256:
        raise HashMismatchError(f"manifest 해시가 다르다({entry.version}): {actual} ≠ {entry.manifest_sha256}")
    verify_signature(data, signature, public_keys)
    try:
        manifest = Manifest.from_bytes(data)
    except FormatError as e:
        raise ContentError(str(e)) from None
    if manifest.version != entry.version:
        raise ContentError(f"manifest 의 버전이 채널과 다르다: {manifest.version} ≠ {entry.version}")
    if manifest.min_upgrade_from != entry.min_upgrade_from:
        raise ContentError(f"min_upgrade_from 이 채널과 다르다({entry.version})")
    if manifest.published != entry.published:
        raise ContentError(f"공개 시각이 채널과 다르다({entry.version})")
    return manifest


def verify_file_hash(data: bytes, expected_sha256: str, label: str = "파일") -> None:
    actual = sha256_hex(data)
    if actual != expected_sha256:
        raise HashMismatchError(f"{label} 해시가 다르다: {actual} ≠ {expected_sha256}")


# ── 버전 조건·업그레이드 경로 ────────────────────────────────


def can_upgrade_directly(current: str, entry: ReleaseEntry) -> bool:
    """`current` 에서 이 릴리스로 한 번에 올라갈 수 있는가(더 높은 버전이고 `min_upgrade_from` 이상)."""
    cur, tgt = semver.parse(current), semver.parse(entry.version)
    if not cur < tgt:
        return False
    return entry.min_upgrade_from is None or cur >= semver.parse(entry.min_upgrade_from)


def upgrade_path(current: str, target: str, releases: Sequence[ReleaseEntry]) -> list[str]:
    """`current` 에서 `target` 까지 차례로 설치할 버전 목록(마지막이 `target`).

    한 번에 갈 수 있으면 `[target]`. `min_upgrade_from` 때문에 못 가면 그 사이의 릴리스를 거친다 —
    거치는 횟수가 가장 적은 경로를 고르고, 같은 횟수면 더 높은 버전을 먼저 거친다.
    이미 그 버전이면 빈 목록. 내려가는 방향이거나 경로가 없으면 UpgradeError.
    """
    cur, tgt = semver.parse(current), semver.parse(target)
    by_version = {r.version: r for r in releases}
    if target not in by_version:
        raise UpgradeError(f"채널에 없는 버전이다: {target}")
    if cur == tgt:
        return []
    if tgt < cur:
        raise UpgradeError(f"다운그레이드는 하지 않는다({current} → {target})")
    between = sorted(
        (r for r in releases if cur < semver.parse(r.version) <= tgt),
        key=lambda r: semver.parse(r.version),
        reverse=True,
    )
    queue: deque[tuple[str, list[str]]] = deque([(current, [])])
    seen = {current}
    while queue:
        at, path = queue.popleft()
        for r in between:
            if r.version in seen or not can_upgrade_directly(at, r):
                continue
            step = path + [r.version]
            if r.version == target:
                return step
            seen.add(r.version)
            queue.append((r.version, step))
    need = by_version[target].min_upgrade_from
    raise UpgradeError(f"{current} 에서 {target} 로 가는 경로가 없다(최소 {need} 필요, 거쳐 갈 릴리스 없음)")


ACTION_CURRENT = "current"   # 이미 최신 — 할 일 없음
ACTION_UPDATE = "update"     # `path` 순서대로 올린다
ACTION_WAIT = "wait"         # 채널의 최신이 현재보다 낮다(Beta → Stable 전환 직후) — 따라잡을 때까지 기다린다
ACTION_BLOCKED = "blocked"   # 새 버전이 있지만 갈 경로가 없다


@dataclass(frozen=True)
class UpdatePlan:
    action: str
    current: str
    target: str | None = None        # 채널의 최신 버전(없으면 None)
    path: tuple[str, ...] = ()       # ACTION_UPDATE 일 때 차례로 설치할 버전
    reason: str = ""


def latest_release(channel: Channel) -> ReleaseEntry | None:
    if not channel.releases:
        return None
    return max(channel.releases, key=lambda r: semver.parse(r.version))


def plan_update(current: str, channel: Channel) -> UpdatePlan:
    """검증을 통과한 채널과 현재 설치 버전으로 무엇을 할지 정한다.

    - 채널의 최신이 현재와 같다 → `current`
    - 최신이 현재보다 높다 → `update` + 경로(없으면 `blocked`)
    - 최신이 현재보다 낮다 → `wait`. Beta 를 쓰다가 Stable 채널로 바꾼 직후가 이렇다
      (예: 현재 `1.2.0-beta.3`, Stable 최신 `1.1.4`). 내려가지 않고, Stable 이 현재 버전 이상이
      되면(`1.2.0` 은 `1.2.0-beta.3` 보다 높다) 그때 올라간다.
    """
    semver.parse(current)
    newest = latest_release(channel)
    if newest is None:
        return UpdatePlan(ACTION_CURRENT, current, None, (), "채널에 릴리스가 없다")
    cur, top = semver.parse(current), semver.parse(newest.version)
    if cur == top:
        return UpdatePlan(ACTION_CURRENT, current, newest.version, (), "최신이다")
    if top < cur:
        return UpdatePlan(
            ACTION_WAIT, current, newest.version, (),
            f"{channel.channel} 채널의 최신({newest.version})이 현재({current})보다 낮다 — 현재 버전 이상이 나올 때까지 기다린다",
        )
    try:
        path = upgrade_path(current, newest.version, channel.releases)
    except UpgradeError as e:
        return UpdatePlan(ACTION_BLOCKED, current, newest.version, (), str(e))
    return UpdatePlan(ACTION_UPDATE, current, newest.version, tuple(path), "")
