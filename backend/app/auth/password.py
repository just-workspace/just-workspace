"""비밀번호 해싱 — OWASP Password Storage 권고 준거.

기본 스킴은 **Argon2id**. Password Hashing Competition(2015) 우승 알고리즘이며
OWASP 가 1순위로 지정하고 있다. bcrypt 와의 핵심 차이는 메모리 경도로,
검증마다 수십 MB 를 점유하게 하여 GPU/ASIC 병렬 크래킹을 무력화한다.
(bcrypt 는 4KB 만 사용하므로 GPU 병렬화가 용이하다.)

파라미터는 OWASP 최소 권고치: m=19MiB, t=2, p=1.

기존 해시 호환:
  argon2  ← 신규 (기본)
  bcrypt_sha256, bcrypt  ← 검증만 가능, deprecated

로그인 시 verify_and_upgrade() 가 구 스킴을 감지하여 새 해시를 반환하므로,
사용자는 다음 로그인 1회로 별도 조치 없이 이관된다.

참고로 순수 bcrypt 는 입력을 72바이트에서 **경고 없이 절단한다** — 앞 72바이트가
동일하면 이후가 상이해도 동일한 비밀번호로 취급된다. NIST SP 800-63B-4 가 요구하는
"최소 64자 허용(SHALL)"과 충돌하는 지점이며, 본 이관으로 함께 해소된다.

bcrypt 5 부터는 절단 대신 72바이트 초과 입력에 ValueError 를 발생시킨다. 구 스킴
``bcrypt`` 해시는 절단된 72바이트로 생성된 것이므로, 해당 해시를 검증할 때에만 기존
동작과 동일하게 72바이트로 절단하여 전달한다(_legacy_bcrypt_secret). 이를 통해 긴 비밀번호를
사용하던 사용자가 로그인하여 Argon2id 로 이관될 수 있다. 신규 해시(argon2)와
bcrypt_sha256(HMAC 으로 사전 축약)은 길이 제한이 없어 해당 없음.
(passlib 1.7.4 → libpass: import 이름·API 동일. requirements.txt 주석 참고.)
"""

import unicodedata

from passlib.context import CryptContext

# 구 스킴 순수 bcrypt 해시의 접두어(passlib ident). bcrypt_sha256 은 "$bcrypt-sha256$" 이므로 중복되지 않는다.
_LEGACY_BCRYPT_PREFIXES = ("$2a$", "$2b$", "$2y$", "$2$")


def _legacy_bcrypt_secret(plain: str, hashed: str) -> str | bytes:
    """순수 bcrypt 해시 검증 시에만 기존 bcrypt(<5) 와 동일하게 UTF-8 72바이트로 절단하여 반환한다."""
    if hashed.startswith(_LEGACY_BCRYPT_PREFIXES):
        raw = plain.encode("utf-8")
        if len(raw) > 72:
            return raw[:72]
    return plain

pwd_context = CryptContext(
    schemes=["argon2", "bcrypt_sha256", "bcrypt"],
    default="argon2",
    deprecated=["bcrypt_sha256", "bcrypt"],
    argon2__type="ID",          # Argon2id (side-channel + GPU 양쪽 방어)
    argon2__memory_cost=19456,  # 19 MiB — OWASP 최소 권고
    argon2__time_cost=2,
    argon2__parallelism=1,
)


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def _candidates(plain: str) -> list[str]:
    """검증에 사용할 입력 후보 — NFKC 정규화본 우선, 원문과 상이하면 원문도 포함.

    가입·변경·재설정은 비밀번호를 NFKC 로 정규화하여 저장한다(schemas.py). 검증 시 원문만 확인하면
    한글 낱자모(ㅔㅁㄴㄴ…)·전각 문자·"…" 처럼 정규화로 형태가 변하는 비밀번호는 설정 직후부터
    일치하지 않는다. 반대로 정규화본만 확인하면, 정규화 적용 전에 생성한 계정(최초 관리자·시드 등 원문
    그대로 해시한 경우)이 차단되므로 원문도 추가로 확인한다.
    """
    norm = unicodedata.normalize("NFKC", plain)
    return [norm] if norm == plain else [norm, plain]


def verify_password(plain: str, hashed: str) -> bool:
    for cand in _candidates(plain):
        try:
            if pwd_context.verify(_legacy_bcrypt_secret(cand, hashed), hashed):
                return True
        except ValueError:
            return False  # 손상되었거나 알 수 없는 형식
    return False


def verify_and_upgrade(plain: str, hashed: str) -> tuple[bool, str | None]:
    """(검증결과, 새 해시 또는 None).

    새 해시가 None 이 아니면 호출자가 DB 에 저장해야 한다(구 스킴 → Argon2id 이관).
    """
    for cand in _candidates(plain):
        try:
            ok, new_hash = pwd_context.verify_and_update(_legacy_bcrypt_secret(cand, hashed), hashed)
        except ValueError:
            return False, None
        if not ok:
            continue
        if new_hash is not None:
            # 새 해시는 절단하지 않은 전체 입력으로 생성한다. 이관 후에는 72바이트 제한이 해소되어야 한다.
            # 저장 규칙(가입·변경)과 동일하게 NFKC 정규화본으로 해시한다.
            new_hash = hash_password(unicodedata.normalize("NFKC", plain))
        return True, new_hash
    return False, None
