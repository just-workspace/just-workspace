"""외부 AI 로 보내기 전 개인정보 가리기.

개인정보위 「생성형 AI 개발·활용 개인정보 처리 안내서」(2025-08)·ISMS-P 실무 요구에 맞춰, 외부(상용) AI
제공자로 나가는 대화·도구 결과에서 고유식별정보·연락처·금융정보를 가린다. 내부(자체 호스팅) 모델에는
적용하지 않는다. 관리자 설정 ai.gov.mask_pii(기본 켬).

가리는 것: 주민등록번호·외국인등록번호, 휴대폰·유선 전화번호, 카드번호(Luhn 검증), 계좌번호(하이픈 3~4묶음).
이메일 주소는 업무에 필요해 가리지 않는다. IP 주소는 점 구분이라 걸리지 않는다.
"""

from __future__ import annotations

import re

_RRN = re.compile(r"(?<!\d)(\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])-?([1-8])\d{6}(?!\d)")
_MOBILE = re.compile(r"(?<!\d)01[016789][-\s.]?\d{3,4}[-\s.]?\d{4}(?!\d)")
_PHONE = re.compile(r"(?<!\d)0(2|[3-6][1-5]|70)[-\s.)]?\d{3,4}[-\s.]\d{4}(?!\d)")
_CARD = re.compile(r"(?<!\d)(\d{4})[-\s](\d{4})[-\s](\d{4})[-\s](\d{4})(?!\d)")
# 계좌: 숫자 묶음 3~4개를 하이픈으로, 전체 10~16자리. 날짜(2026-11-05)·버전(1.2.3)은 자리수로 걸러진다.
_ACCOUNT = re.compile(r"(?<![\d-])(\d{2,6})-(\d{2,6})-(\d{2,8})(?:-(\d{1,4}))?(?![\d-])")


def _luhn(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _card(m: re.Match) -> str:
    digits = "".join(m.groups())
    return "[카드번호]" if _luhn(digits) else m.group(0)


def _account(m: re.Match) -> str:
    digits = "".join(g for g in m.groups() if g)
    if not 10 <= len(digits) <= 16:
        return m.group(0)
    # 4-4-4-4 는 카드 모양 — 카드 검증(Luhn)을 통과 못 했으면 일련번호 등이라 계좌로 보지 않는다
    if all(g and len(g) == 4 for g in m.groups()):
        return m.group(0)
    # 날짜처럼 보이는 앞 4자리 연도(19xx/20xx)+월 묶음은 그대로 둔다
    if len(m.group(1)) == 4 and m.group(1)[:2] in ("19", "20") and len(m.group(2)) <= 2:
        return m.group(0)
    return "[계좌번호]"


def mask_text(text: str) -> str:
    if not text or not isinstance(text, str):
        return text
    text = _RRN.sub("[주민등록번호]", text)
    text = _CARD.sub(_card, text)
    text = _MOBILE.sub("[전화번호]", text)
    text = _PHONE.sub("[전화번호]", text)
    text = _ACCOUNT.sub(_account, text)
    return text


def mask_messages(msgs: list[dict]) -> list[dict]:
    out = []
    for m in msgs:
        c = m.get("content")
        if isinstance(c, str):
            m = {**m, "content": mask_text(c)}
        elif isinstance(c, list):   # 멀티파트(텍스트+이미지)
            m = {**m, "content": [({**p, "text": mask_text(p["text"])} if isinstance(p, dict) and isinstance(p.get("text"), str) else p) for p in c]}
        out.append(m)
    return out
