"""NIST SP 800-63B-4 준거 비밀번호 정책.

800-63B-4 (2025-08 확정) §3.1.1.2 Password Verifiers 요약:

  - 최소 8자 SHALL / 15자 이상 SHOULD
  - **최소 64자까지는 허용해야 한다 SHALL**
  - "Other composition rules SHALL NOT be imposed"
      → 대문자·소문자·숫자·특수문자 강제는 표준 위반. rev3 의 "should not" 이
        rev4 에서 "shall not" 으로 격상됐다. 복잡도 강제는 Password123! 류의
        예측 가능한 패턴을 유도해 오히려 강도를 떨어뜨린다.
  - 유출/흔한 비밀번호 **블록리스트 검사 SHALL**
  - 인쇄 가능한 ASCII·공백·유니코드 전부 허용 SHALL, 유니코드는 정규화
  - 주기적 강제 변경 SHALL NOT (침해 정황이 있을 때만)

즉 "복잡도 규칙"을 "길이 + 블록리스트"로 대체하는 것이 표준 정합이다.
"""

import re
import unicodedata
from pathlib import Path

# ── 길이 ────────────────────────────────────────────────────────────
MIN_LENGTH = 8            # SHALL
RECOMMENDED_LENGTH = 15   # SHOULD — 경고용, 거부하지 않는다
MAX_LENGTH = 256          # SHALL(>=64) 을 넉넉히 상회. bcrypt_sha256 이라 72바이트 제한 없음

# ── 블록리스트 ──────────────────────────────────────────────────────
# 운영 중 확장하려면 이 파일에 한 줄에 하나씩 추가한다(대소문자 무시).
# SecLists 등의 top-10k 목록을 그대로 떨궈 넣어도 된다.
_BLOCKLIST_FILE = Path(__file__).parent / "data" / "common_passwords.txt"

_BUILTIN_BLOCKLIST = {
    "123456", "password", "123456789", "12345678", "12345", "1234567",
    "1234567890", "qwerty", "abc123", "111111", "123123", "admin",
    "letmein", "welcome", "monkey", "dragon", "sunshine", "princess",
    "football", "baseball", "iloveyou", "trustno1", "passw0rd",
    "password1", "password123", "qwerty123", "qwertyuiop", "1q2w3e4r",
    "1qaz2wsx", "zaq12wsx", "asdfghjkl", "superman", "batman",
    "michael", "shadow", "master", "jennifer", "jordan", "hunter",
    "harley", "ranger", "buster", "thomas", "robert", "soccer",
    "killer", "george", "sexy", "andrew", "charlie", "andrea",
    "matrix", "secret", "summer", "internet", "service", "canada",
    "hello", "ninja", "computer", "starwars", "cheese", "freedom",
    "whatever", "nicole", "jessica", "purple", "anthony", "pepper",
    "chicken", "changeme", "default", "guest", "test", "test123",
    "root", "toor", "administrator", "system", "server", "oracle",
    "postgres", "mysql", "docker", "qwer1234", "asdf1234", "zxcv1234",
    "a1b2c3d4", "abcd1234", "1234qwer", "p@ssw0rd", "p@ssword",
    "admin123", "root123", "user123", "welcome1", "welcome123",
    "login", "pass", "passwd", "secret123", "letmein123",
    # 한국어권에서 흔한 것
    "dkssud", "dkssudgktpdy", "wkdrjs", "tkfkd", "rlaqjs", "qwer1234!",
    "korea", "seoul", "samsung", "daehan", "hangul",
}


def _load_blocklist() -> set[str]:
    words = set(_BUILTIN_BLOCKLIST)
    try:
        if _BLOCKLIST_FILE.is_file():
            with _BLOCKLIST_FILE.open(encoding="utf-8", errors="replace") as f:
                for line in f:
                    w = line.strip().lower()
                    if w and not w.startswith("#"):
                        words.add(w)
    except OSError:
        pass
    return words


_BLOCKLIST = _load_blocklist()

# 복잡도 규칙을 형식적으로 만족시키는 전형적 우회형(Password123!, P@ssw0rd! 등)을
# 잡기 위한 정규화. 뒤에 붙은 숫자·기호를 떼고, leet 치환을 되돌린 어간으로도 대조한다.
_LEET = str.maketrans({"@": "a", "0": "o", "1": "l", "3": "e", "4": "a",
                       "5": "s", "7": "t", "$": "s", "!": "i"})


def _stems(low: str) -> set[str]:
    out = {low}
    stem = re.sub(r"[^a-z]+$", "", low)      # 끝에 붙은 숫자·기호 제거
    if stem:
        out.add(stem)
        out.add(stem.translate(_LEET))
    out.add(low.translate(_LEET))
    return out


_SEQUENCES = (
    "abcdefghijklmnopqrstuvwxyz",
    "qwertyuiop", "asdfghjkl", "zxcvbnm",
    "01234567890",
)


def normalize(password: str) -> str:
    """유니코드 비밀번호를 NFKC 로 정규화한다(800-63B-4 SHALL).

    정규화하지 않으면 시각적으로 동일한 문자열이 다른 바이트열이 되어
    등록한 비밀번호로 로그인이 안 되는 일이 생긴다.
    """
    return unicodedata.normalize("NFKC", password)


def _strip_context(pw_low: str, *context: str | None) -> str:
    """사용자명·이메일 같은 문맥 문자열을 제거한 나머지를 돌려준다."""
    out = pw_low
    for c in context:
        if c and len(c) >= 3:
            out = out.replace(c.lower(), "")
            local = c.lower().split("@")[0]
            if len(local) >= 3:
                out = out.replace(local, "")
    return out


def validate(password: str, *context: str | None) -> None:
    """정책 위반 시 ValueError 를 던진다. 통과하면 조용히 반환.

    context 에는 사용자명·이메일·표시이름 등 추측에 쓰일 값을 넘긴다.
    """
    pw = normalize(password)

    if len(pw) < MIN_LENGTH:
        raise ValueError(f"비밀번호는 최소 {MIN_LENGTH}자 이상이어야 합니다")
    if len(pw) > MAX_LENGTH:
        raise ValueError(f"비밀번호는 최대 {MAX_LENGTH}자까지 사용할 수 있습니다")

    low = pw.lower()

    # 유출·흔한 비밀번호 (SHALL). 어간·leet 복원형까지 대조한다.
    if _BLOCKLIST & _stems(low):
        raise ValueError("너무 흔하거나 유출된 적이 있는 비밀번호입니다. 다른 것을 사용해주세요")

    # 문맥 정보(사용자명/이메일)로 이루어진 비밀번호
    stripped = _strip_context(low, *context)
    if len(stripped) < MIN_LENGTH:
        raise ValueError("사용자명이나 이메일이 그대로 들어간 비밀번호는 사용할 수 없습니다")

    # 같은 문자 반복 (aaaaaaaa)
    if len(set(low)) == 1:
        raise ValueError("같은 문자만 반복된 비밀번호는 사용할 수 없습니다")

    # 순차 문자열 (abcdefgh, 12345678, qwertyui)
    for seq in _SEQUENCES:
        if len(low) >= MIN_LENGTH and (low in seq or low in seq[::-1]):
            raise ValueError("연속된 문자·숫자로만 이루어진 비밀번호는 사용할 수 없습니다")

    # 짧은 단위의 단순 반복 (abcabcabc, 121212)
    for unit in range(1, 5):
        if len(low) >= unit * 3 and low == (low[:unit] * (len(low) // unit) + low[:len(low) % unit]):
            raise ValueError("짧은 문자열이 반복된 비밀번호는 사용할 수 없습니다")


def _is_pattern(low: str) -> bool:
    """같은 문자 반복 · 순차 문자열 · 짧은 단위 반복 — validate 의 패턴 검사와 같은 기준."""
    if len(set(low)) == 1:
        return True
    for seq in _SEQUENCES:
        if len(low) >= MIN_LENGTH and (low in seq or low in seq[::-1]):
            return True
    for unit in range(1, 5):
        if len(low) >= unit * 3 and low == (low[:unit] * (len(low) // unit) + low[:len(low) % unit]):
            return True
    return False


def check(password: str, *context: str | None) -> dict:
    """규칙별 판정(설정 › 보안 비밀번호 체크 목록). validate 와 같은 기준을 항목으로 나눠 돌려준다.

    - length  : 8자 이상(256자 이하)
    - common  : 흔한·유출 비밀번호이거나 반복·연속 패턴(True 면 "흔한 비밀번호")
    - context : 아이디·이메일을 빼면 8자가 안 됨(True 면 "아이디·이메일과 같음")
    """
    pw = normalize(password or "")
    low = pw.lower()
    length_ok = MIN_LENGTH <= len(pw) <= MAX_LENGTH
    common = bool(low) and (bool(_BLOCKLIST & _stems(low)) or _is_pattern(low))
    stripped = _strip_context(low, *context)
    # 아이디·이메일이 실제로 들어 있고, 빼고 나면 8자가 안 될 때만(짧은 것은 length 가 맡는다)
    contextual = stripped != low and len(stripped) < MIN_LENGTH
    return {"length": length_ok, "common": common, "context": contextual,
            "ok": length_ok and not common and not contextual}


def is_weak_but_allowed(password: str) -> bool:
    """거부하지는 않지만 더 길게 쓰기를 권하는 구간(15자 미만)."""
    return len(normalize(password)) < RECOMMENDED_LENGTH
