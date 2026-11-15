"""채널 파일과 릴리스 목록 파일(manifest)의 데이터 모델·직렬화.

서명 대상 바이트(결정적 직렬화) 규칙 — `canonical_bytes()`:

1. JSON 객체의 키는 유니코드 코드포인트 순으로 정렬한다(모든 깊이).
2. 구분자는 `,` 와 `:` — 공백·들여쓰기·줄바꿈을 넣지 않는다.
3. 인코딩은 UTF-8(BOM 없음). 비 ASCII 문자는 `\\uXXXX` 로 바꾸지 않고 그대로 쓴다.
4. 값은 문자열·정수·불리언·null·배열·객체만 쓴다. 실수는 쓰지 않는다(표기가 구현마다 달라진다).
5. 파일 끝에 줄바꿈(`\\n`, LF) 하나를 붙인다.
6. 배열의 순서는 의미가 있으므로 그대로 둔다(릴리스 목록은 버전 오름차순으로 만들어 넣는다).

서명은 **파일에 적힌 바이트 그대로**에 건다. 검증하는 쪽은 받은 바이트를 다시 직렬화하지 않고
그대로 검증한 뒤에 해석한다 — 위 규칙은 만드는 쪽이 같은 내용에서 늘 같은 바이트를 내기 위한 것이다.

이 모듈은 표준 라이브러리만 쓴다.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Mapping

from . import semver

FORMAT = 1
CHANNELS = ("stable", "beta")
APP_KINDS = ("windows-desktop", "android")

_SHA256 = re.compile(r"[0-9a-f]{64}")
_DIGEST_REF = re.compile(r"[a-z0-9][a-z0-9._\-/:]*@sha256:[0-9a-f]{64}")
_TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
_NAME = re.compile(r"[a-z0-9][a-z0-9._-]*")
_REL_PATH = re.compile(r"[A-Za-z0-9._+-]+(?:/[A-Za-z0-9._+-]+)*")


class FormatError(ValueError):
    """파일 내용이 형식에 맞지 않는다."""


# ── 결정적 직렬화 ─────────────────────────────────────────────


def _check_plain(value: Any, where: str = "$") -> None:
    if value is None or isinstance(value, (str, bool)):
        return
    if isinstance(value, int):
        return
    if isinstance(value, float):
        raise FormatError(f"{where}: 실수는 쓸 수 없다")
    if isinstance(value, (list, tuple)):
        for i, item in enumerate(value):
            _check_plain(item, f"{where}[{i}]")
        return
    if isinstance(value, Mapping):
        for key, item in value.items():
            if not isinstance(key, str):
                raise FormatError(f"{where}: 키는 문자열이어야 한다")
            _check_plain(item, f"{where}.{key}")
        return
    raise FormatError(f"{where}: 쓸 수 없는 값 종류 {type(value).__name__}")


def canonical_bytes(data: Mapping[str, Any]) -> bytes:
    """서명 대상 바이트. 규칙은 이 모듈 머리말."""
    _check_plain(data)
    text = json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return text.encode("utf-8") + b"\n"


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def loads(data: bytes) -> dict[str, Any]:
    """바이트 → JSON 객체. 중복 키·실수·객체가 아닌 최상위를 거부한다."""

    def pairs(items):
        out: dict[str, Any] = {}
        for key, value in items:
            if key in out:
                raise FormatError(f"중복 키: {key}")
            out[key] = value
        return out

    def no_float(text):
        raise FormatError(f"실수는 쓸 수 없다: {text}")

    try:
        obj = json.loads(data.decode("utf-8"), object_pairs_hook=pairs, parse_float=no_float, parse_constant=no_float)
    except UnicodeDecodeError as e:
        raise FormatError(f"UTF-8 이 아니다: {e}") from None
    except json.JSONDecodeError as e:
        raise FormatError(f"JSON 이 아니다: {e}") from None
    if not isinstance(obj, dict):
        raise FormatError("최상위가 객체가 아니다")
    return obj


# ── 시각 ─────────────────────────────────────────────────────


def format_time(t: datetime) -> str:
    """UTC, 초 단위, `YYYY-MM-DDTHH:MM:SSZ`."""
    if t.tzinfo is None:
        raise ValueError("시간대 없는 시각은 쓸 수 없다")
    return t.astimezone(timezone.utc).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_time(text: str) -> datetime:
    if not isinstance(text, str) or not _TIME.fullmatch(text):
        raise FormatError(f"시각 형식이 아니다(YYYY-MM-DDTHH:MM:SSZ): {text!r}")
    try:
        return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError as e:
        raise FormatError(f"시각이 아니다: {text!r} ({e})") from None


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


# ── 검사 도우미 ──────────────────────────────────────────────


def _need(d: Mapping[str, Any], key: str, kind, where: str):
    if key not in d:
        raise FormatError(f"{where}: `{key}` 가 없다")
    value = d[key]
    if kind is int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise FormatError(f"{where}.{key}: 정수여야 한다")
    elif not isinstance(value, kind):
        raise FormatError(f"{where}.{key}: 형식이 다르다")
    return value


def _only(d: Mapping[str, Any], allowed: set[str], where: str) -> None:
    extra = sorted(set(d) - allowed)
    if extra:
        raise FormatError(f"{where}: 모르는 항목 {extra}")


def _version(text: Any, where: str) -> str:
    if not semver.is_product_version(text):
        raise FormatError(f"{where}: 버전 꼴이 아니다(X.Y.Z 또는 X.Y.Z-beta.N): {text!r}")
    return text


def _opt_version(text: Any, where: str) -> str | None:
    return None if text is None else _version(text, where)


def _sha(text: Any, where: str) -> str:
    if not isinstance(text, str) or not _SHA256.fullmatch(text):
        raise FormatError(f"{where}: SHA-256(소문자 16진 64자)이 아니다")
    return text


def _size(value: Any, where: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise FormatError(f"{where}: 크기는 0 이상의 정수여야 한다")
    return value


def _url(text: Any, where: str) -> str:
    if not isinstance(text, str) or not re.fullmatch(r"https?://\S+", text):
        raise FormatError(f"{where}: 주소(http/https)가 아니다")
    return text


def _image_map(d: Any, where: str) -> dict[str, str]:
    if not isinstance(d, dict):
        raise FormatError(f"{where}: 객체여야 한다")
    out: dict[str, str] = {}
    for name, ref in d.items():
        if not _NAME.fullmatch(name):
            raise FormatError(f"{where}: 이름 꼴이 아니다: {name!r}")
        if not isinstance(ref, str) or not _DIGEST_REF.fullmatch(ref):
            raise FormatError(f"{where}.{name}: `저장소@sha256:…` 꼴이 아니다: {ref!r}")
        out[name] = ref
    return out


# ── 채널 ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class ReleaseEntry:
    """채널 파일의 릴리스 한 줄."""

    version: str
    published: str
    manifest_path: str
    manifest_sha256: str
    min_upgrade_from: str | None = None
    summary: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "published": self.published,
            "min_upgrade_from": self.min_upgrade_from,
            "manifest": {"path": self.manifest_path, "sha256": self.manifest_sha256},
            "summary": self.summary,
        }

    @classmethod
    def from_dict(cls, d: Any, where: str = "release") -> "ReleaseEntry":
        if not isinstance(d, dict):
            raise FormatError(f"{where}: 객체여야 한다")
        _only(d, {"version", "published", "min_upgrade_from", "manifest", "summary"}, where)
        version = _version(_need(d, "version", str, where), f"{where}.version")
        published = _need(d, "published", str, where)
        parse_time(published)
        if "min_upgrade_from" not in d:
            raise FormatError(f"{where}: `min_upgrade_from` 이 없다(제약이 없으면 null)")
        muf = _opt_version(d["min_upgrade_from"], f"{where}.min_upgrade_from")
        man = _need(d, "manifest", dict, where)
        _only(man, {"path", "sha256"}, f"{where}.manifest")
        path = _need(man, "path", str, f"{where}.manifest")
        if not _REL_PATH.fullmatch(path) or ".." in path.split("/"):
            raise FormatError(f"{where}.manifest.path: 상대 경로가 아니다: {path!r}")
        sha = _sha(_need(man, "sha256", str, f"{where}.manifest"), f"{where}.manifest.sha256")
        summary = _need(d, "summary", str, where)
        if "\n" in summary or "\r" in summary:
            raise FormatError(f"{where}.summary: 한 줄이어야 한다")
        return cls(version, published, path, sha, muf, summary)


@dataclass(frozen=True)
class Channel:
    channel: str
    sequence: int
    generated: str
    expires: str
    releases: tuple[ReleaseEntry, ...] = ()
    format: int = FORMAT

    def to_dict(self) -> dict[str, Any]:
        return {
            "format": self.format,
            "channel": self.channel,
            "sequence": self.sequence,
            "generated": self.generated,
            "expires": self.expires,
            "releases": [r.to_dict() for r in self.releases],
        }

    def to_bytes(self) -> bytes:
        return canonical_bytes(self.to_dict())

    @classmethod
    def from_dict(cls, d: Any) -> "Channel":
        where = "channel"
        if not isinstance(d, dict):
            raise FormatError("채널 파일: 객체여야 한다")
        _only(d, {"format", "channel", "sequence", "generated", "expires", "releases"}, where)
        fmt = _need(d, "format", int, where)
        if fmt != FORMAT:
            raise FormatError(f"채널 파일: 모르는 형식 버전 {fmt}(지원 {FORMAT})")
        name = _need(d, "channel", str, where)
        if name not in CHANNELS:
            raise FormatError(f"채널 파일: 모르는 채널 {name!r}")
        seq = _need(d, "sequence", int, where)
        if seq < 1:
            raise FormatError("채널 파일: sequence 는 1 이상이어야 한다")
        generated = _need(d, "generated", str, where)
        expires = _need(d, "expires", str, where)
        if parse_time(expires) <= parse_time(generated):
            raise FormatError("채널 파일: expires 가 generated 보다 뒤여야 한다")
        raw = _need(d, "releases", list, where)
        releases = tuple(ReleaseEntry.from_dict(r, f"releases[{i}]") for i, r in enumerate(raw))
        seen: set[str] = set()
        prev = None
        for r in releases:
            if r.version in seen:
                raise FormatError(f"채널 파일: 같은 버전이 두 번 있다: {r.version}")
            seen.add(r.version)
            v = semver.parse(r.version)
            if prev is not None and not prev < v:
                raise FormatError("채널 파일: releases 는 버전 오름차순이어야 한다")
            prev = v
            if name == "stable" and not semver.is_stable(r.version):
                raise FormatError(f"채널 파일: stable 채널에 Beta 버전이 있다: {r.version}")
        return cls(name, seq, generated, expires, releases, fmt)

    @classmethod
    def from_bytes(cls, data: bytes) -> "Channel":
        return cls.from_dict(loads(data))

    def find(self, version: str) -> ReleaseEntry | None:
        for r in self.releases:
            if r.version == version:
                return r
        return None

    def with_release(self, entry: ReleaseEntry) -> "Channel":
        """릴리스를 더한 새 채널(순번·시각은 그대로 — `bumped()` 로 올린다)."""
        if self.find(entry.version):
            raise FormatError(f"{self.channel} 채널에 이미 {entry.version} 이 있다")
        if self.channel == "stable" and not semver.is_stable(entry.version):
            raise FormatError(f"stable 채널에는 Beta 버전을 넣을 수 없다: {entry.version}")
        releases = sorted(self.releases + (entry,), key=lambda r: semver.parse(r.version))
        return Channel(self.channel, self.sequence, self.generated, self.expires, tuple(releases), self.format)

    def bumped(self, now: datetime, expires_days: int) -> "Channel":
        """순번 +1, 생성 시각·만료 시각 갱신."""
        if expires_days < 1:
            raise ValueError("만료 기간은 1일 이상이어야 한다")
        return Channel(
            self.channel,
            self.sequence + 1,
            format_time(now),
            format_time(now + timedelta(days=expires_days)),
            self.releases,
            self.format,
        )


def new_channel(name: str) -> Channel:
    """빈 채널(순번 0 — 게시하면서 `bumped()` 로 1 이 된다). 파일로 쓰지 않는 중간 값이다."""
    if name not in CHANNELS:
        raise FormatError(f"모르는 채널 {name!r}")
    epoch = "1970-01-01T00:00:00Z"
    return Channel(name, 0, epoch, epoch, ())


# ── manifest ────────────────────────────────────────────────


@dataclass(frozen=True)
class FileRef:
    """내려받는 파일 하나(주소·크기·해시)."""

    url: str
    size: int
    sha256: str

    def to_dict(self) -> dict[str, Any]:
        return {"url": self.url, "size": self.size, "sha256": self.sha256}

    @classmethod
    def from_dict(cls, d: Any, where: str) -> "FileRef":
        if not isinstance(d, dict):
            raise FormatError(f"{where}: 객체여야 한다")
        _only(d, {"url", "size", "sha256"}, where)
        return cls(
            _url(_need(d, "url", str, where), f"{where}.url"),
            _size(_need(d, "size", int, where), f"{where}.size"),
            _sha(_need(d, "sha256", str, where), f"{where}.sha256"),
        )


@dataclass(frozen=True)
class AppFile:
    """앱 설치 파일."""

    kind: str
    filename: str
    size: int
    sha256: str
    url: str

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "filename": self.filename, "size": self.size, "sha256": self.sha256, "url": self.url}

    @classmethod
    def from_dict(cls, d: Any, where: str) -> "AppFile":
        if not isinstance(d, dict):
            raise FormatError(f"{where}: 객체여야 한다")
        _only(d, {"kind", "filename", "size", "sha256", "url"}, where)
        kind = _need(d, "kind", str, where)
        if kind not in APP_KINDS:
            raise FormatError(f"{where}.kind: 모르는 종류 {kind!r}")
        filename = _need(d, "filename", str, where)
        if not filename or "/" in filename or "\\" in filename:
            raise FormatError(f"{where}.filename: 파일 이름이 아니다")
        return cls(
            kind,
            filename,
            _size(_need(d, "size", int, where), f"{where}.size"),
            _sha(_need(d, "sha256", str, where), f"{where}.sha256"),
            _url(_need(d, "url", str, where), f"{where}.url"),
        )


_MANIFEST_KEYS = {
    "format", "version", "published", "min_upgrade_from", "promoted_from", "db_schema", "images", "third_party",
    "zones", "installer_bundle", "apps", "offline_bundle", "changelog", "plugin_api", "download_bytes",
}


@dataclass(frozen=True)
class Manifest:
    version: str
    published: str
    images: dict[str, str]
    third_party: dict[str, dict[str, str]]
    zones_sha256: str
    zones_content: dict[str, Any]
    min_upgrade_from: str | None = None
    promoted_from: str | None = None
    db_schema: int | str | None = None            # 자리 — 값은 backend 가 정한다
    installer_bundle: FileRef | None = None       # 자리 — compose·템플릿 묶음
    apps: tuple[AppFile, ...] = ()
    offline_bundle: FileRef | None = None
    changelog: str = ""
    plugin_api: dict[str, Any] | None = None      # 자리 — 플러그인 호환 범위
    download_bytes: int | None = None             # 선택 — 이미지 압축 크기의 합. 모르면 키 자체를 싣지 않는다
    format: int = FORMAT

    def to_dict(self) -> dict[str, Any]:
        out = {
            "format": self.format,
            "version": self.version,
            "published": self.published,
            "min_upgrade_from": self.min_upgrade_from,
            "promoted_from": self.promoted_from,
            "db_schema": self.db_schema,
            "images": dict(self.images),
            "third_party": {zone: dict(m) for zone, m in self.third_party.items()},
            "zones": {"sha256": self.zones_sha256, "content": self.zones_content},
            "installer_bundle": self.installer_bundle.to_dict() if self.installer_bundle else None,
            "apps": [a.to_dict() for a in self.apps],
            "offline_bundle": self.offline_bundle.to_dict() if self.offline_bundle else None,
            "changelog": self.changelog,
            "plugin_api": self.plugin_api,
        }
        if self.download_bytes is not None:
            out["download_bytes"] = self.download_bytes
        return out

    def to_bytes(self) -> bytes:
        return canonical_bytes(self.to_dict())

    @classmethod
    def from_dict(cls, d: Any) -> "Manifest":
        where = "manifest"
        if not isinstance(d, dict):
            raise FormatError("manifest: 객체여야 한다")
        _only(d, _MANIFEST_KEYS, where)
        fmt = _need(d, "format", int, where)
        if fmt != FORMAT:
            raise FormatError(f"manifest: 모르는 형식 버전 {fmt}(지원 {FORMAT})")
        version = _version(_need(d, "version", str, where), "manifest.version")
        published = _need(d, "published", str, where)
        parse_time(published)
        for key in ("min_upgrade_from", "promoted_from", "db_schema", "installer_bundle", "offline_bundle", "plugin_api"):
            if key not in d:
                raise FormatError(f"manifest: `{key}` 가 없다(없으면 null)")
        muf = _opt_version(d["min_upgrade_from"], "manifest.min_upgrade_from")
        promoted = d["promoted_from"]
        if promoted is not None:
            if not semver.is_beta(promoted):
                raise FormatError("manifest.promoted_from: Beta 버전이어야 한다")
            if not semver.is_stable(version) or semver.stable_of(promoted) != version:
                raise FormatError("manifest.promoted_from: 이 버전의 Beta 가 아니다")
        db_schema = d["db_schema"]
        if db_schema is not None and (isinstance(db_schema, bool) or not isinstance(db_schema, (int, str))):
            raise FormatError("manifest.db_schema: 정수·문자열·null 이어야 한다")
        images = _image_map(_need(d, "images", dict, where), "manifest.images")
        if not images:
            raise FormatError("manifest.images: 비어 있다")
        tp_raw = _need(d, "third_party", dict, where)
        third: dict[str, dict[str, str]] = {}
        for zone, m in tp_raw.items():
            if not _NAME.fullmatch(zone):
                raise FormatError(f"manifest.third_party: 구역 이름 꼴이 아니다: {zone!r}")
            third[zone] = _image_map(m, f"manifest.third_party.{zone}")
        zones = _need(d, "zones", dict, where)
        _only(zones, {"sha256", "content"}, "manifest.zones")
        zsha = _sha(_need(zones, "sha256", str, "manifest.zones"), "manifest.zones.sha256")
        zcontent = _need(zones, "content", dict, "manifest.zones")
        apps_raw = _need(d, "apps", list, where)
        apps = tuple(AppFile.from_dict(a, f"manifest.apps[{i}]") for i, a in enumerate(apps_raw))
        changelog = _need(d, "changelog", str, where)
        plugin_api = d["plugin_api"]
        if plugin_api is not None and not isinstance(plugin_api, dict):
            raise FormatError("manifest.plugin_api: 객체 또는 null 이어야 한다")
        download_bytes = None
        if "download_bytes" in d:       # 선택 항목 — 있으면 정수여야 한다(null 은 받지 않는다: 모르면 키를 뺀다)
            download_bytes = _size(d["download_bytes"], "manifest.download_bytes")
        ib = d["installer_bundle"]
        ob = d["offline_bundle"]
        return cls(
            version=version,
            published=published,
            images=images,
            third_party=third,
            zones_sha256=zsha,
            zones_content=zcontent,
            min_upgrade_from=muf,
            promoted_from=promoted,
            db_schema=db_schema,
            installer_bundle=FileRef.from_dict(ib, "manifest.installer_bundle") if ib is not None else None,
            apps=apps,
            offline_bundle=FileRef.from_dict(ob, "manifest.offline_bundle") if ob is not None else None,
            changelog=changelog,
            plugin_api=plugin_api,
            download_bytes=download_bytes,
            format=fmt,
        )

    @classmethod
    def from_bytes(cls, data: bytes) -> "Manifest":
        return cls.from_dict(loads(data))

    def all_image_refs(self) -> dict[str, str]:
        """우리 이미지 + 남의 이미지(구역 무시) 이름 → 참조."""
        out = dict(self.images)
        for m in self.third_party.values():
            out.update(m)
        return out


def manifest_rel_path(version: str) -> str:
    """채널 리포 안에서 manifest 의 상대 경로."""
    _version(version, "version")
    return f"releases/{version}/manifest.json"


def channel_rel_path(channel: str) -> str:
    if channel not in CHANNELS:
        raise FormatError(f"모르는 채널 {channel!r}")
    return f"channels/{channel}.json"


def zones_fingerprint(raw: bytes) -> tuple[str, dict[str, Any]]:
    """zones.json 원문 → (SHA-256, 내용).

    해시는 원문 바이트가 아니라 **내용을 결정적 직렬화한 바이트**의 것이다 — 줄바꿈·들여쓰기가 달라도
    같은 값이 나오고, manifest 만 가진 쪽이 `content` 에서 다시 계산해 맞춰 볼 수 있다.
    """
    content = loads(raw)
    return sha256_hex(canonical_bytes(content)), content
