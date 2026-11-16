"""스토리지 백엔드 추상화 — 로컬/NFS/SMB(파일시스템) + S3/MinIO(오브젝트).

설정은 DB(storage.backend, storage.s3.*)에 저장한다 — K8s/배포 방식 무관. 기본값은 filesystem(=현행 /storage, 변경 없음).
참고: 파일시스템(로컬/NFS/SMB)은 동일한 /storage 마운트이므로 백엔드 코드가 동일하다 — 마운트만 오케스트레이션에서 교체한다.
   S3 는 앱 레벨에서 배포 방식과 무관하게 동작한다(본 추상화 사용).
"""
from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from app.setup import config_store as cfg


class StorageBackend:
    async def put_bytes(self, key: str, data: bytes) -> None: raise NotImplementedError
    async def get_bytes(self, key: str) -> bytes: raise NotImplementedError
    async def delete(self, key: str) -> None: raise NotImplementedError
    async def exists(self, key: str) -> bool: raise NotImplementedError


class FilesystemBackend(StorageBackend):
    """로컬/NFS/SMB — /storage 마운트에 직접 기록(현행 동작)."""
    def __init__(self, root: str = "/storage"):
        self.root = Path(root)

    def _p(self, key: str) -> Path:
        p = (self.root / key.lstrip("/")).resolve()
        if not str(p).startswith(str(self.root.resolve())):
            raise ValueError("path traversal")
        return p

    async def put_bytes(self, key, data):
        p = self._p(key); p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(data)

    async def get_bytes(self, key): return self._p(key).read_bytes()

    async def delete(self, key):
        try: self._p(key).unlink()
        except FileNotFoundError: pass

    async def exists(self, key): return self._p(key).exists()


class S3Backend(StorageBackend):
    """S3 / MinIO 호환 오브젝트 스토리지(앱 레벨, 배포 방식 무관)."""
    def __init__(self, endpoint, region, bucket, access_key, secret_key, prefix=""):
        import boto3
        self.bucket = bucket
        self.prefix = (prefix or "").strip("/")
        self.s3 = boto3.client(
            "s3",
            endpoint_url=endpoint or None,
            region_name=region or None,
            aws_access_key_id=access_key or None,
            aws_secret_access_key=secret_key or None,
        )

    def _k(self, key: str) -> str:
        key = key.lstrip("/")
        return f"{self.prefix}/{key}" if self.prefix else key

    async def put_bytes(self, key, data):
        await asyncio.to_thread(self.s3.put_object, Bucket=self.bucket, Key=self._k(key), Body=data)

    async def get_bytes(self, key):
        r = await asyncio.to_thread(self.s3.get_object, Bucket=self.bucket, Key=self._k(key))
        return r["Body"].read()

    async def delete(self, key):
        await asyncio.to_thread(self.s3.delete_object, Bucket=self.bucket, Key=self._k(key))

    async def exists(self, key):
        try:
            await asyncio.to_thread(self.s3.head_object, Bucket=self.bucket, Key=self._k(key))
            return True
        except Exception:
            return False


async def _s3_from_params(p: dict, secret: str | None = None) -> S3Backend:
    return S3Backend(
        endpoint=p.get("endpoint", ""), region=p.get("region", ""), bucket=p.get("bucket", ""),
        access_key=p.get("access_key", ""), secret_key=secret if secret is not None else p.get("secret_key", ""),
        prefix=p.get("prefix", ""),
    )


async def get_backend(db: AsyncSession) -> StorageBackend:
    kind = await cfg.get(db, "storage.backend", "filesystem")
    if kind == "s3":
        s = await cfg.get_by_prefix(db, "storage.s3.")
        secret = ""
        enc = s.get("storage.s3.secret_key")
        if enc:
            try:
                from app.mail.crypto import decrypt_password
                secret = decrypt_password(enc)
            except Exception:
                secret = ""
        return S3Backend(
            endpoint=s.get("storage.s3.endpoint", ""), region=s.get("storage.s3.region", ""),
            bucket=s.get("storage.s3.bucket", ""), access_key=s.get("storage.s3.access_key", ""),
            secret_key=secret, prefix=s.get("storage.s3.prefix", ""),
        )
    return FilesystemBackend(os.getenv("STORAGE_ROOT", "/storage"))


async def test_backend(b: StorageBackend) -> tuple[bool, str]:
    key = f"_jw_test_{int(time.time())}.txt"
    try:
        await b.put_bytes(key, b"jw-ok")
        v = await b.get_bytes(key)
        await b.delete(key)
        return (v == b"jw-ok", "쓰기/읽기/삭제 정상" if v == b"jw-ok" else "검증 불일치")
    except Exception as e:  # noqa: BLE001
        return (False, str(e)[:200])
