"""백업 형식 — 단일 형식만 존재한다.

백업은 **디렉터리** 하나이다. 그 안에 `manifest.json` 과 항목별 파일이 하위 디렉터리 없이 배치된다.

    20260101_030000-full/
      manifest.json          형식 버전·생성한 제품 버전·스키마 버전·시각·항목과 파일별 크기/SHA-256·설치 id·저장소 종류…
      db.dump                pg_dump -Fc
      config.tar[.enc]       .env 를 포함한 설정 묶음(암호 지정 시 .enc — AES-256-GCM)
      mail-config.tar.gz …   항목마다 파일 하나 이상

이전 시에는 해당 디렉터리를 **tar 한 개**(`.jwbak`, 압축 없음 — 항목이 이미 압축되어 있다)로 병합한다. `manifest.json` 이
첫 멤버이므로, 요약(`summarize`)은 파일을 추출하지 않고 앞부분만 읽는다. 두 형태 모두 `open_backup()` 으로 연다.

본 모듈은 표준 라이브러리와 `cryptography` 만 사용한다 — 앱 설정·DB 를 import 하지 않는다(설치 관리자가 그대로 사용할 수 있도록).
백업 대상과 사용 명령은 app/backup/plan.py, 실행은 app/backup/runner.py.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tarfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, Iterator

FORMAT_VERSION = 1
MANIFEST_NAME = "manifest.json"
ARCHIVE_SUFFIX = ".jwbak"

KIND_PRE_UPDATE = "pre-update"      # 업데이트 직전 자동 백업 — db + config
KIND_FULL = "full"                  # 전체 백업·서버 이전용
KINDS = (KIND_PRE_UPDATE, KIND_FULL)

# 항목 id(순서 = 백업 수행 순서). 포함 내용은 docs/data-safety.md.
ITEMS = ("db", "config", "mail", "gitea", "plugins-data", "certs", "app-signing", "files")

_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}")
_CHUNK = 1024 * 1024

# 암호 보호(config 항목)
_ENC_MAGIC = b"JWBAK-ENC-1\n"
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2 ** 15, 8, 1
ENCRYPTION_LABEL = "AES-256-GCM, scrypt(N=32768,r=8,p=1)"

SECRET_WARNING = (
    "이 백업에는 암호화 키(SECRET_KEY)와 DB·서비스 비밀번호가 들어 있습니다. "
    "백업 파일을 가진 사람은 서버의 모든 데이터를 읽을 수 있습니다 — 접근을 제한된 곳에 두세요."
)


class BackupError(Exception):
    """백업을 읽을 수 없거나 신뢰할 수 없다(형식·해시·암호)."""


# ─── 파일 처리 ───


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_stream(f: BinaryIO) -> tuple[str, int]:
    h, size = hashlib.sha256(), 0
    for chunk in iter(lambda: f.read(_CHUNK), b""):
        h.update(chunk)
        size += len(chunk)
    return h.hexdigest(), size


def restrict(path: Path) -> None:
    """소유자만 읽기·쓰기 허용(파일 600, 디렉터리 700). 권한 개념이 없는 파일시스템이면 무시한다."""
    try:
        os.chmod(path, 0o700 if path.is_dir() else 0o600)
    except OSError:
        pass


def secret_fingerprint(secret_key: str) -> str:
    """암호화 키의 지문 — 값은 노출하지 않고 "같은 키인가"만 비교할 수 있다."""
    if not secret_key:
        return ""
    return hashlib.sha256(b"jw-backup-key-fingerprint\0" + secret_key.encode()).hexdigest()[:16]


# ─── 암호 보호 ───


def _derive(password: str, salt: bytes) -> bytes:
    from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

    return Scrypt(salt=salt, length=32, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P).derive(password.encode("utf-8"))


def encrypt_bytes(data: bytes, password: str) -> bytes:
    """암호로 대칭 암호화한다. 결과 = 헤더 | salt(16) | nonce(12) | 암호문+인증 태그."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    if not password:
        raise BackupError("암호가 비어 있습니다")
    salt, nonce = os.urandom(16), os.urandom(12)
    return _ENC_MAGIC + salt + nonce + AESGCM(_derive(password, salt)).encrypt(nonce, data, _ENC_MAGIC)


def decrypt_bytes(blob: bytes, password: str) -> bytes:
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    head = len(_ENC_MAGIC)
    if not blob.startswith(_ENC_MAGIC) or len(blob) < head + 28 + 16:
        raise BackupError("암호화된 항목의 형식이 아닙니다")
    if not password:
        raise BackupError("이 백업의 설정 항목은 암호로 보호돼 있습니다 — 암호가 필요합니다")
    salt, nonce, body = blob[head:head + 16], blob[head + 16:head + 28], blob[head + 28:]
    try:
        return AESGCM(_derive(password, salt)).decrypt(nonce, body, _ENC_MAGIC)
    except InvalidTag:
        raise BackupError("암호가 틀렸거나 설정 항목이 손상됐습니다") from None


# ─── manifest ───


@dataclass
class Manifest:
    data: dict[str, Any]

    @property
    def kind(self) -> str:
        return self.data.get("kind", "")

    @property
    def schema_version(self) -> int:
        return int(self.data.get("schema_version") or 0)

    @property
    def items(self) -> dict[str, dict]:
        return self.data.get("items") or {}

    def files(self, item: str | None = None) -> list[dict]:
        """(항목의) 파일 목록 — [{name, size, sha256}]."""
        picked = [self.items[item]] if item else list(self.items.values())
        return [f for it in picked for f in it.get("files", [])]

    def file(self, item: str, role: str) -> dict | None:
        for f in self.items.get(item, {}).get("files", []):
            if f.get("role") == role:
                return f
        return None

    @property
    def config_encrypted(self) -> bool:
        return bool(self.items.get("config", {}).get("encrypted"))


def new_manifest(
    *,
    kind: str,
    product_version: str,
    schema_version: int,
    install_id: str = "",
    domain: str = "",
    app_url: str = "",
    zones: list[str] | None = None,
    storage: dict | None = None,
    stats: dict | None = None,
    postgres_version: int | None = None,
    secret_key_fingerprint: str = "",
    created_at: datetime | None = None,
) -> dict:
    if kind not in KINDS:
        raise BackupError(f"모르는 백업 종류: {kind}")
    return {
        "format": FORMAT_VERSION,
        "kind": kind,
        "created_at": (created_at or datetime.now(timezone.utc)).isoformat(timespec="seconds"),
        "product_version": product_version,
        "schema_version": int(schema_version),
        "postgres_version": postgres_version,
        "install_id": install_id,
        "domain": domain,
        "app_url": app_url,
        "zones": list(zones or []),
        "storage": storage or {"kind": "local"},
        "stats": stats or {},
        "secret_key_fingerprint": secret_key_fingerprint,
        "items": {},
        "skipped": {},
        "warnings": [],
    }


def add_item(manifest: dict, root: Path, item: str, files: list[tuple[str, str]], **extra: Any) -> None:
    """항목을 manifest 에 등록한다. files = [(파일 이름, 역할)]. 크기·SHA-256 은 여기서 계산한다."""
    if item not in ITEMS:
        raise BackupError(f"모르는 항목: {item}")
    entries = []
    for name, role in files:
        if not _NAME_RE.fullmatch(name) or name == MANIFEST_NAME:
            raise BackupError(f"쓸 수 없는 파일 이름: {name}")
        path = root / name
        restrict(path)
        entries.append({"name": name, "role": role, "size": path.stat().st_size, "sha256": sha256_file(path)})
    manifest["items"][item] = {"files": entries, **extra}


def write_manifest(root: Path, manifest: dict) -> None:
    path = root / MANIFEST_NAME
    tmp = root / (MANIFEST_NAME + ".tmp")
    tmp.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    restrict(tmp)
    os.replace(tmp, path)
    restrict(root)


def _parse_manifest(raw: bytes) -> Manifest:
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise BackupError("manifest.json 을 읽을 수 없습니다(손상)") from None
    if not isinstance(data, dict) or "format" not in data or not isinstance(data.get("items"), dict):
        raise BackupError("manifest.json 이 백업 형식이 아닙니다")
    if data["format"] != FORMAT_VERSION:
        raise BackupError(
            f"백업 형식 버전 {data['format']} 은(는) 이 버전이 읽을 수 없습니다(읽을 수 있는 버전: {FORMAT_VERSION})"
        )
    for item, body in data["items"].items():
        for f in body.get("files", []):
            if not _NAME_RE.fullmatch(str(f.get("name", ""))) or f["name"] == MANIFEST_NAME:
                raise BackupError(f"manifest 의 파일 이름이 올바르지 않습니다: {item}")
    return Manifest(data)


# ─── 열기 ───


@dataclass
class Backup:
    """열린 백업 — 디렉터리이거나 tar 한 개."""

    path: Path
    manifest: Manifest
    is_archive: bool
    total_bytes: int = 0
    _extra: list[str] = field(default_factory=list)

    def open_file(self, name: str) -> BinaryIO:
        if not self.is_archive:
            return open(self.path / name, "rb")
        tar = tarfile.open(self.path, "r:")
        member = tar.extractfile(tar.getmember(name))
        if member is None:
            tar.close()
            raise BackupError(f"백업 안에 파일이 없습니다: {name}")
        return member  # type: ignore[return-value]

    def read_file(self, name: str) -> bytes:
        with self.open_file(name) as f:
            return f.read()


def open_backup(path: str | os.PathLike) -> Backup:
    """백업을 연다(디렉터리 또는 tar). manifest 만 읽는다 — 내용 검증은 `verify()`."""
    p = Path(path)
    if p.is_dir():
        mf = p / MANIFEST_NAME
        if not mf.is_file():
            raise BackupError(f"백업이 아닙니다(manifest.json 없음): {p}")
        manifest = _parse_manifest(mf.read_bytes())
        total = sum(f.stat().st_size for f in p.iterdir() if f.is_file())
        return Backup(p, manifest, is_archive=False, total_bytes=total)
    if not p.is_file():
        raise BackupError(f"백업을 찾을 수 없습니다: {p}")
    try:
        with tarfile.open(p, "r:") as tar:
            first = tar.next()
            if first is None or first.name != MANIFEST_NAME or not first.isfile() or first.size > 8 * 1024 * 1024:
                raise BackupError("백업 파일이 아닙니다(첫 항목이 manifest.json 이 아님)")
            manifest = _parse_manifest(tar.extractfile(first).read())  # type: ignore[union-attr]
    except tarfile.TarError:
        raise BackupError("백업 파일을 읽을 수 없습니다(tar 형식이 아니거나 손상)") from None
    return Backup(p, manifest, is_archive=True, total_bytes=p.stat().st_size)


def _iter_archive(path: Path) -> Iterator[tuple[tarfile.TarInfo, BinaryIO | None]]:
    with tarfile.open(path, "r:") as tar:
        for member in tar:
            yield member, (tar.extractfile(member) if member.isfile() else None)


def verify(backup: Backup, *, password: str | None = None) -> list[str]:
    """모든 파일의 크기·SHA-256 을 manifest 와 대조한다. 반환값: 문제 목록(비어 있으면 정상).

    password 를 지정하면 암호화된 설정 항목이 해당 암호로 복호화되는지도 확인한다.
    """
    problems: list[str] = []
    expected = {f["name"]: f for f in backup.manifest.files()}
    seen: set[str] = set()

    def check(name: str, digest: str, size: int) -> None:
        want = expected[name]
        if size != want.get("size"):
            problems.append(f"{name}: 크기가 다릅니다(기록 {want.get('size')}, 실제 {size})")
        elif digest != want.get("sha256"):
            problems.append(f"{name}: 내용이 기록과 다릅니다(SHA-256 불일치)")

    if backup.is_archive:
        try:
            for member, f in _iter_archive(backup.path):
                if member.name == MANIFEST_NAME:
                    continue
                if f is None or member.name not in expected:
                    problems.append(f"{member.name}: manifest 에 없는 항목")
                    continue
                seen.add(member.name)
                check(member.name, *_sha256_stream(f))
        except (tarfile.TarError, OSError, EOFError):
            problems.append("백업 파일이 중간에 끊겼거나 손상됐습니다")
    else:
        for name in expected:
            path = backup.path / name
            if path.is_file():
                seen.add(name)
                check(name, sha256_file(path), path.stat().st_size)
    problems += [f"{name}: 파일이 없습니다" for name in expected if name not in seen]

    if not problems and password is not None and backup.manifest.config_encrypted:
        try:
            read_config_tar(backup, password)
        except BackupError as e:
            problems.append(f"config: {e}")
    return problems


def read_config_tar(backup: Backup, password: str | None = None) -> bytes:
    """설정 묶음(tar 바이트)을 반환한다. 암호화되어 있으면 복호화한다."""
    entry = backup.manifest.file("config", "config")
    if entry is None:
        raise BackupError("이 백업에는 설정 항목이 없습니다")
    blob = backup.read_file(entry["name"])
    return decrypt_bytes(blob, password or "") if backup.manifest.config_encrypted else blob


# ─── 병합·추출 ───


def pack(root: Path, dest: Path) -> Path:
    """백업 디렉터리를 tar 한 개로 병합한다(manifest.json 이 첫 멤버)."""
    backup = open_backup(root)
    tmp = dest.with_name(dest.name + ".part")
    with tarfile.open(tmp, "w:") as tar:
        tar.add(root / MANIFEST_NAME, arcname=MANIFEST_NAME)
        for f in backup.manifest.files():
            tar.add(root / f["name"], arcname=f["name"])
    restrict(tmp)
    os.replace(tmp, dest)
    return dest


def pack_order(root: Path) -> list[str]:
    """tar 병합 시의 멤버 순서 — manifest.json 이 최우선(내려받기 응답이 `tar -cf - <이 순서>` 로 스트리밍한다)."""
    return [MANIFEST_NAME] + [f["name"] for f in open_backup(root).manifest.files()]


def extract(backup: Backup, dest: Path) -> Path:
    """tar 백업을 디렉터리로 추출한다(manifest 에 있는, 하위 경로 없는 일반 파일만 허용 — 그 외는 거부). 디렉터리 백업이면 그대로 반환한다."""
    if not backup.is_archive:
        return backup.path
    allowed = {f["name"] for f in backup.manifest.files()} | {MANIFEST_NAME}
    dest.mkdir(parents=True, exist_ok=True)
    restrict(dest)
    try:
        for member, f in _iter_archive(backup.path):
            if f is None or member.name not in allowed:
                raise BackupError(f"백업 안에 허용되지 않는 항목이 있습니다: {member.name}")
            target = dest / member.name
            with open(target, "wb") as out:
                for chunk in iter(lambda: f.read(_CHUNK), b""):
                    out.write(chunk)
            restrict(target)
    except (tarfile.TarError, EOFError):
        raise BackupError("백업 파일이 중간에 끊겼거나 손상됐습니다") from None
    return dest


# ─── 요약 ───


def summarize(path: str | os.PathLike) -> dict:
    """백업의 내용 요약 — 추출하지 않고 manifest 만 읽는다(설치 마법사의 "백업에서 복원" 확인 화면용).

    사용자 수·데이터 크기 등의 값은 백업 생성 시 manifest 에 기록한 것이다.
    """
    backup = open_backup(path)
    m = backup.manifest.data
    stats = m.get("stats") or {}
    files_entry = backup.manifest.items.get("files")
    files_bytes = sum(f.get("size", 0) for f in files_entry.get("files", [])) if files_entry else None
    return {
        "format": m["format"],
        "kind": m.get("kind"),
        "created_at": m.get("created_at"),
        "product_version": m.get("product_version"),
        "backup_version": m.get("product_version"),
        "schema_version": backup.manifest.schema_version,
        "postgres_version": m.get("postgres_version"),
        "install_id": m.get("install_id") or "",
        "domain": m.get("domain") or "",
        "source_url": m.get("app_url") or "",
        "zones": m.get("zones") or [],
        "users": stats.get("users"),
        "data_bytes": stats.get("db_bytes"),
        "storage": m.get("storage") or {"kind": "local"},
        "storage_bytes": stats.get("storage_bytes"),
        "files_included": files_entry is not None,
        "files_bytes": files_bytes,
        "items": sorted(backup.manifest.items, key=lambda i: ITEMS.index(i) if i in ITEMS else 99),
        "skipped": m.get("skipped") or {},
        "config_included": "config" in backup.manifest.items,
        "config_encrypted": backup.manifest.config_encrypted,
        "size_bytes": backup.total_bytes,
        "is_archive": backup.is_archive,
    }
