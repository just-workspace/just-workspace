"""비밀번호 해시 라이브러리 교체(passlib 1.7.4 + bcrypt 4.0.1 → libpass + bcrypt 5) 호환 증명.

아래 고정 해시는 **교체 전** 운영 이미지(passlib 1.7.4, bcrypt 4.0.1)에서
app.auth.password.hash_password 와 CryptContext(bcrypt_sha256/bcrypt, rounds=5) 로
만든 것이다. 세 스킴 모두 지금 라이브러리로 검증되고, 구 스킴은 Argon2id 로 이관돼야 한다.

bcrypt 5 는 72바이트 초과 입력에 ValueError 를 내므로(옛 버전은 조용히 잘랐다),
순수 bcrypt 해시의 긴 비밀번호 케이스(long100·long73)가 핵심이다.
"""

import pytest

from app.auth.password import hash_password, verify_and_upgrade, verify_password

PASSWORDS = {
    "short": "correct horse battery staple",
    "korean": "비밀번호-한글-Pässwörd-🔐",
    "long100": "L" * 60 + "0123456789" * 4,
    "exact72": "x" * 72,
    "long73": "x" * 72 + "Y",
}

# passlib 1.7.4 / bcrypt 4.0.1 로 생성
LEGACY_HASHES = {
    "short": {
        "argon2": "$argon2id$v=19$m=19456,t=2,p=1$5JzT+h8jREhJyRlj7L23dg$7IU2qEqJxr+lGQseiT7x86HaduQxtnHeH0gB16NOlZ4",
        "bcrypt_sha256": "$bcrypt-sha256$v=2,t=2b,r=5$.BQ8B7sbYBrbPpqivJQ9ye$omXC1b5CCQ9UMEQhvqMkMgsSZT2eDbW",
        "bcrypt": "$2b$05$bJcvC7HZW0ewwNEQCS8x3u7XfimBKa5XU3sAoK01gvKoqB8RE/lsC",
    },
    "korean": {
        "argon2": "$argon2id$v=19$m=19456,t=2,p=1$mLPWOsd47/0fQ+h97917rw$T2MC5V8oP5fsi/Dfcmo8+9VDr15qKtlqodeg7HfnZwQ",
        "bcrypt_sha256": "$bcrypt-sha256$v=2,t=2b,r=5$LrluyC2TQNu5O79oGikqCe$AXko4NF8594WoAH7NWaM.Q2ZU1QnEAS",
        "bcrypt": "$2b$05$seLTRZfLE4YEobk2KOxnUeAGH0IeD0be4Sd7W9MjPwo4ItzUOP1b6",
    },
    "long100": {
        "argon2": "$argon2id$v=19$m=19456,t=2,p=1$OocQImTM+T9HqNW6F0JojQ$EuBYzEsGbTIuVUptU9jAXIEPpZVTK+Z+hxyH0U5rVhI",
        "bcrypt_sha256": "$bcrypt-sha256$v=2,t=2b,r=5$u.xYUODi/d9KKd3lwSZzq.$.9ljJKjHVYqJK5R6P6fBySkg54QQ4LW",
        "bcrypt": "$2b$05$05ob7GAO8sgt.K9CaIlE2eAyFqKXQwpmq5.yWl3OUIVUujDmctobK",
    },
    "exact72": {
        "argon2": "$argon2id$v=19$m=19456,t=2,p=1$plRKqZXSWksphRCCUAohRA$Z/oiRBebycXv/NSEZFmk/ZHO8/5mDU02V5FO7SrdJEk",
        "bcrypt_sha256": "$bcrypt-sha256$v=2,t=2b,r=5$G48TA4gFs45WgHjPvG0seO$rBtNqI3duqJlYBt0C4wyZhyDol1YYmy",
        "bcrypt": "$2b$05$i5j8SFd6R9KjGiWXgAoUI.a3kVQ34CKFjOogtSrp8QWfiM/JHhuQi",
    },
    "long73": {
        "argon2": "$argon2id$v=19$m=19456,t=2,p=1$i1FKCcFYK+X8/997LyVkDA$eC3zBN/OmmNT7YYmlfBaLAUeo4M3D5AYMjhpgTcJnDc",
        "bcrypt_sha256": "$bcrypt-sha256$v=2,t=2b,r=5$G4XLHCQd0sUYIPCt23ZvGO$TxJ7yL5oCXZrpaQ39UlBuOLFb.fEfBG",
        "bcrypt": "$2b$05$Ucgztkdc30NtkwIYa/jSTeqFLCOUdAMxuH35/Xro6DcDLlI..r/Pm",
    },
}

CASES = [(k, s) for k in PASSWORDS for s in ("argon2", "bcrypt_sha256", "bcrypt")]


@pytest.mark.parametrize("key,scheme", CASES)
def test_legacy_hash_verifies(key, scheme):
    assert verify_password(PASSWORDS[key], LEGACY_HASHES[key][scheme]) is True


@pytest.mark.parametrize("key,scheme", CASES)
def test_legacy_hash_rejects_wrong_password(key, scheme):
    pw, h = PASSWORDS[key], LEGACY_HASHES[key][scheme]
    assert verify_password("Z" + pw[1:], h) is False
    assert verify_password("", h) is False
    if scheme == "bcrypt" and len(pw.encode()) >= 72:
        # 순수 bcrypt 는 앞 72바이트만 보므로 뒤쪽 변형은 "틀린 비밀번호"가 아니다(아래 전용 테스트 참고)
        return
    assert verify_password(pw + "!", h) is False
    assert verify_password(pw[:-1], h) is False


@pytest.mark.parametrize("key", list(PASSWORDS))
def test_legacy_schemes_upgrade_to_argon2id(key):
    for scheme in ("bcrypt_sha256", "bcrypt"):
        ok, new_hash = verify_and_upgrade(PASSWORDS[key], LEGACY_HASHES[key][scheme])
        assert ok is True
        assert new_hash is not None and new_hash.startswith("$argon2id$")
        # 이관된 해시는 잘리지 않은 원문 전체로 검증된다
        assert verify_password(PASSWORDS[key], new_hash) is True
        if len(PASSWORDS[key].encode()) > 72:
            assert verify_password(PASSWORDS[key][:72], new_hash) is False


@pytest.mark.parametrize("key", list(PASSWORDS))
def test_argon2_hash_is_current_scheme(key):
    ok, new_hash = verify_and_upgrade(PASSWORDS[key], LEGACY_HASHES[key]["argon2"])
    assert ok is True
    assert new_hash is None  # 이미 기본 스킴 — 재해시 없음


def test_legacy_plain_bcrypt_keeps_72_byte_truncation_semantics():
    """옛 bcrypt(<5) 는 72바이트 뒤를 무시했다. 그 시절 만든 해시는 그 의미대로 검증돼야 한다.

    long73 의 해시는 실제로는 앞 72바이트("x"*72)로 만들어진 것이므로 exact72 비밀번호로도 통과한다.
    (이 느슨함은 로그인 즉시 Argon2id 이관으로 사라진다 — test_legacy_schemes_upgrade_to_argon2id.)
    """
    h73 = LEGACY_HASHES["long73"]["bcrypt"]
    assert verify_password(PASSWORDS["long73"], h73) is True
    assert verify_password(PASSWORDS["exact72"], h73) is True
    assert verify_password("x" * 71, h73) is False
    # bcrypt_sha256 은 HMAC 으로 먼저 줄이므로 72바이트 의미론이 없다
    assert verify_password(PASSWORDS["exact72"], LEGACY_HASHES["long73"]["bcrypt_sha256"]) is False


def test_new_hash_roundtrip_and_params():
    for pw in PASSWORDS.values():
        h = hash_password(pw)
        assert h.startswith("$argon2id$v=19$m=19456,t=2,p=1$")
        assert verify_password(pw, h) is True
        assert verify_password(pw + "x", h) is False


def test_garbage_hash_is_rejected_not_raised():
    assert verify_password("anything", "not-a-hash") is False
    assert verify_password("anything", "") is False
    assert verify_and_upgrade("anything", "$2b$05$short") == (False, None)
