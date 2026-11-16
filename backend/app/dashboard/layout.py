"""대시보드 카드 배치 — 값 형식 검증·정규화.

동일한 형식을 두 곳에서 사용한다.
- 개인 배치: /api/me/prefs 의 `dash.layout` (사용자가 편집 모드에서 변경하면 즉시 저장, 기기 간 동기화)
- 관리자 기본 배치: 관리 › 설정 › 대시보드 → appcfg `dash.layout` (/api/health config 로 전체 공개 — 비밀 정보 아님)

형식:
    {"v": 1, "order": [카드 키…], "hidden": [카드 키…], "size": {카드 키: 1|2}, "locked": [카드 키…]}
- order: 표시 순서. 알 수 없는 키·중복은 제거한다(order 에 없는 키는 프런트가 기본 순서 위치에 삽입한다).
- hidden: 숨긴 카드. size: 1칸/2칸(열이 1개이면 화면에서 1칸으로 축소한다).
- locked: 관리자 고정 카드 — 관리자 기본 배치에서만 유효하다(사용자는 숨김·크기 변경 불가, 순서만 변경 가능).
  개인 배치에 포함된 locked 는 제거한다.
"""

from __future__ import annotations

# 프런트 lib/dashLayout.ts CARD_KEYS 와 동일해야 함
CARD_KEYS = (
    "start", "inbox", "today", "ai", "cont", "tasks", "mail", "later", "team", "git",
    "board", "notice", "chans", "store", "meet", "discover",
    # 네트워크 랩(NETLAB_URL 이 설정된 경우에만 프런트가 사용 가능한 카드로 취급)
    "lab",
)
LAYOUT_VERSION = 1


def _keys(v) -> list[str]:
    if not isinstance(v, list):
        return []
    out: list[str] = []
    for k in v:
        if isinstance(k, str) and k in CARD_KEYS and k not in out:
            out.append(k)
    return out


def normalize_layout(value, *, allow_locked: bool = False) -> dict:
    """검증 후 정규화한 배치를 반환한다. 객체가 아니면 ValueError."""
    if not isinstance(value, dict):
        raise ValueError("대시보드 배치는 객체여야 합니다")
    size_raw = value.get("size") if isinstance(value.get("size"), dict) else {}
    size = {k: int(s) for k, s in size_raw.items() if k in CARD_KEYS and s in (1, 2) and not isinstance(s, bool)}
    out = {
        "v": LAYOUT_VERSION,
        "order": _keys(value.get("order")),
        "hidden": _keys(value.get("hidden")),
        "size": size,
    }
    if allow_locked:
        out["locked"] = _keys(value.get("locked"))
    return out
