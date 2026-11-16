"""채널 리포 작업 디렉터리 처리 — 게시·만료 갱신·전체 검증.

채널 리포의 배치:

    channels/stable.json  channels/stable.json.sig
    channels/beta.json    channels/beta.json.sig
    releases/<버전>/manifest.json  releases/<버전>/manifest.json.sig

본 모듈의 함수는 파일만 기록한다. git 커밋·푸시는 수행하지 않는다(릴리스 담당자가 확인 후 수행).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Callable

from cryptography.hazmat.primitives.asymmetric import ec

from . import semver, verify
from .model import (
    CHANNELS,
    Channel,
    FormatError,
    Manifest,
    ReleaseEntry,
    channel_rel_path,
    manifest_rel_path,
    new_channel,
    sha256_hex,
)
from .sign import SIG_SUFFIX, sign_bytes


class RepoError(Exception):
    """채널 리포 작업 수행 불가."""


@dataclass
class Result:
    written: list[str] = field(default_factory=list)      # 기록한 파일(리포 기준 상대 경로)
    unsigned: list[str] = field(default_factory=list)     # 서명 미부여 파일
    notes: list[str] = field(default_factory=list)


def _write(repo: Path, rel: str, data: bytes, result: Result) -> None:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    result.written.append(rel)


def _put_signed(repo: Path, rel: str, data: bytes, key: ec.EllipticCurvePrivateKey | None, result: Result) -> None:
    """파일과 서명을 기록한다. 키가 없으면 기존 서명을 삭제하고 '서명 필요' 상태로 남긴다."""
    _write(repo, rel, data, result)
    sig_rel = rel + SIG_SUFFIX
    if key is not None:
        _write(repo, sig_rel, sign_bytes(data, key), result)
    else:
        stale = repo / sig_rel
        if stale.exists():
            stale.unlink()
        result.unsigned.append(rel)


def load_channel(repo: Path, name: str) -> Channel | None:
    path = repo / channel_rel_path(name)
    if not path.exists():
        return None
    try:
        return Channel.from_bytes(path.read_bytes())
    except FormatError as e:
        raise RepoError(f"{channel_rel_path(name)}: {e}") from None


def channels_for(version: str, channel: str) -> tuple[str, ...]:
    """이 릴리스를 포함할 채널 파일 목록. Stable 릴리스는 Beta 채널에도 포함된다."""
    if channel not in CHANNELS:
        raise RepoError(f"모르는 채널: {channel}")
    if channel == "stable":
        if not semver.is_stable(version):
            raise RepoError(f"stable 채널에는 X.Y.Z 버전만 낸다: {version}")
        return ("stable", "beta")
    if not semver.is_beta(version):
        raise RepoError(f"beta 채널에 직접 내는 것은 X.Y.Z-beta.N 버전이다: {version} (Stable 은 --channel stable 로 내면 beta 에도 들어간다)")
    return ("beta",)


def publish(
    repo: Path,
    manifest_bytes: bytes,
    channel: str,
    *,
    key: ec.EllipticCurvePrivateKey | None,
    now: datetime,
    expires_days: int,
    summary: str = "",
    manifest_sig: bytes | None = None,
) -> Result:
    """manifest 를 `releases/<버전>/` 에 저장하고 채널 파일을 갱신(순번 +1, 만료 갱신)·서명한다.

    `key` 가 없으면 서명 없이 파일만 기록한다(타 도구로 서명하는 경우). `manifest_sig` 는 사전 생성한
    manifest 서명을 그대로 포함할 때 지정한다.
    """
    try:
        manifest = Manifest.from_bytes(manifest_bytes)
    except FormatError as e:
        raise RepoError(f"manifest: {e}") from None
    targets = channels_for(manifest.version, channel)
    result = Result()

    rel = manifest_rel_path(manifest.version)
    existing = repo / rel
    if existing.exists() and existing.read_bytes() != manifest_bytes:
        raise RepoError(f"{rel} 이 이미 있고 내용이 다르다 — 낸 릴리스는 고치지 않는다(새 버전으로 낸다)")

    updated: list[Channel] = []
    for name in targets:
        current = load_channel(repo, name) or new_channel(name)
        entry = ReleaseEntry(
            version=manifest.version,
            published=manifest.published,
            manifest_path=rel,
            manifest_sha256=sha256_hex(manifest_bytes),
            min_upgrade_from=manifest.min_upgrade_from,
            summary=summary,
        )
        try:
            updated.append(current.with_release(entry).bumped(now, expires_days))
        except FormatError as e:
            raise RepoError(str(e)) from None

    if manifest_sig is not None:
        _write(repo, rel, manifest_bytes, result)
        _write(repo, rel + SIG_SUFFIX, manifest_sig, result)
    else:
        _put_signed(repo, rel, manifest_bytes, key, result)
    for ch in updated:
        _put_signed(repo, channel_rel_path(ch.channel), ch.to_bytes(), key, result)
        result.notes.append(f"{ch.channel}: 순번 {ch.sequence}, 만료 {ch.expires}, 릴리스 {len(ch.releases)}개")
    return result


def refresh(
    repo: Path,
    channels: tuple[str, ...],
    *,
    key: ec.EllipticCurvePrivateKey | None,
    now: datetime,
    expires_days: int,
) -> Result:
    """릴리스 없이 채널 파일의 만료만 갱신한다(순번 +1)."""
    result = Result()
    for name in channels:
        current = load_channel(repo, name)
        if current is None:
            raise RepoError(f"{channel_rel_path(name)} 이 없다")
        ch = current.bumped(now, expires_days)
        _put_signed(repo, channel_rel_path(name), ch.to_bytes(), key, result)
        result.notes.append(f"{name}: 순번 {ch.sequence}, 만료 {ch.expires}")
    return result


# ── 전체 검증 ────────────────────────────────────────────────

Fetch = Callable[[str], bytes]
"""상대 경로 → 바이트. 없으면 FileNotFoundError."""


def dir_fetch(repo: Path) -> Fetch:
    def fetch(rel: str) -> bytes:
        return (repo / rel).read_bytes()

    return fetch


@dataclass
class Report:
    ok: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    channels: dict[str, Channel] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        return not self.errors


def verify_all(
    fetch: Fetch,
    public_keys,
    *,
    now: datetime,
    channels: tuple[str, ...] = CHANNELS,
    last_sequences: dict[str, int] | None = None,
) -> Report:
    """채널 파일과 그에 기록된 모든 manifest 를 검증한다(일부 실패 시에도 끝까지 검증하여 오류를 취합·보고한다)."""
    report = Report()
    last_sequences = last_sequences or {}
    seen_manifests: dict[str, str] = {}
    for name in channels:
        rel = channel_rel_path(name)
        try:
            data, sig = fetch(rel), fetch(rel + SIG_SUFFIX)
        except FileNotFoundError as e:
            report.errors.append(f"{rel}: 파일 또는 서명이 없다({e})")
            continue
        try:
            ch = verify.verify_channel(
                data, sig, public_keys, now=now, expected_channel=name, last_sequence=last_sequences.get(name)
            )
        except verify.VerifyError as e:
            report.errors.append(f"{rel}: {e}")
            continue
        report.channels[name] = ch
        report.ok.append(f"{rel}: 순번 {ch.sequence}, 만료 {ch.expires}, 릴리스 {len(ch.releases)}개")
        for entry in ch.releases:
            mrel = entry.manifest_path
            if seen_manifests.get(mrel) == entry.manifest_sha256:
                continue
            try:
                mdata, msig = fetch(mrel), fetch(mrel + SIG_SUFFIX)
            except FileNotFoundError as e:
                report.errors.append(f"{mrel}: 파일 또는 서명이 없다({e})")
                continue
            try:
                verify.verify_manifest(mdata, msig, public_keys, entry)
            except verify.VerifyError as e:
                report.errors.append(f"{mrel} ({name}): {e}")
                continue
            seen_manifests[mrel] = entry.manifest_sha256
            report.ok.append(f"{mrel}: {entry.version}")
    stable, beta = report.channels.get("stable"), report.channels.get("beta")
    if stable is not None and beta is not None:
        for entry in stable.releases:
            if beta.find(entry.version) != entry:
                report.errors.append(f"beta 채널에 Stable 릴리스 {entry.version} 이 없거나 내용이 다르다")
    return report
