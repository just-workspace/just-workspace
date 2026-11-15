"""비밀번호 해싱 — OWASP Password Storage 권고 준거.

기본 스킴은 **Argon2id**. Password Hashing Competition(2015) 우승 알고리즘이고
OWASP 가 1순위로 지정하고 있다. bcrypt 와의 결정적 차이는 메모리 경도로,
검증마다 수십 MB 를 점유시켜 GPU/ASIC 병렬 크래킹을 무력화한다.
(bcrypt 는 4KB 만 쓰기 때문에 GPU 로 잘 병렬화된다.)

파라미터는 OWASP 최소 권고치: m=19MiB, t=2, p=1.

기존 해시 호환:
  argon2  ← 신규 (기본)
  bcrypt_sha256, bcrypt  ← 검증만 가능, deprecated

로그인 시 verify_and_upgrade() 가 구 스킴을 감지해 새 해시를 돌려주므로,
사용자는 다음 로그인 한 번으로 조용히 이관된다.

참고로 순수 bcrypt 는 입력을 72바이트에서 **조용히 잘라낸다** — 앞 72바이트가
같으면 뒤가 달라도 같은 비밀번호로 취급된다. NIST SP 800-63B-4 가 요구하는
"최소 64자 허용(SHALL)"과 충돌하는 지점이라, 이 이관으로 함께 해소된다.

bcrypt 5 부터는 잘라내는 대신 72바이트 초과 입력에 ValueError 를 낸다. 구 스킴
``bcrypt`` 해시는 잘린 72바이트로 만들어진 것이므로, 그 해시를 검증할 때만 옛
동작과 똑같이 72바이트로 잘라 넘긴다(_legacy_bcrypt_secret). 그래야 긴 비밀번호를
쓰던 사용자가 로그인해서 Argon2id 로 이관될 수 있다. 신규 해시(argon2)와
bcrypt_sha256(HMAC 으로 먼저 줄임)은 길이 제한이 없어 해당 없음.
(passlib 1.7.4 → libpass: import 이름·API 동일. requirements.txt 주석 참고.)
"""

import unicodedata

from passlib.context import CryptContext

# 구 스킴 순수 bcrypt 해시의 접두어(passlib ident). bcrypt_sha256 은 "$bcrypt-sha256$" 라 겹치지 않는다.
_LEGACY_BCRYPT_PREFIXES = ("$2a$", "$2b$", "$2y$", "$2$")


def _legacy_bcrypt_secret(plain: str, hashed: str) -> str | bytes:
    """순수 bcrypt 해시를 검증할 때만 옛 bcrypt(<5) 처럼 UTF-8 72바이트로 잘라 돌려준다."""
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
    """검증에 넣어 볼 입력 — NFKC 정규화본 먼저, 다르면 원문도.

    가입·변경·재설정은 비밀번호를 NFKC 로 정규화해 저장한다(schemas.py). 검증이 원문만 보면
    한글 낱자모(ㅔㅁㄴㄴ…)·전각 문자·"…" 처럼 정규화로 모양이 바뀌는 비밀번호는 설정 직후부터
    영영 맞지 않는다. 그렇다고 정규화본만 보면, 정규화 전에 만든 계정(최초 관리자·시드 등 원문
    그대로 해시한 것)이 막히므로 원문도 한 번 더 본다.
    """
    norm = unicodedata.normalize("NFKC", plain)
    return [norm] if norm == plain else [norm, plain]


def verify_password(plain: str, hashed: str) -> bool:
    for cand in _candidates(plain):
        try:
            if pwd_context.verify(_legacy_bcrypt_secret(cand, hashed), hashed):
                return True
        except ValueError:
            return False  # 손상됐거나 알 수 없는 형식
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
            # 새 해시는 잘리지 않은 전체로 만든다 — 이관 뒤에는 72바이트 제한이 사라져야 한다.
            # 저장 규칙(가입·변경)과 같게 NFKC 정규화본으로 해시한다.
            new_hash = hash_password(unicodedata.normalize("NFKC", plain))
        return True, new_hash
    return False, None
