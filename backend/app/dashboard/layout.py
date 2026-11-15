"""대시보드 카드 배치 — 값 모양 검사·정규화.

같은 모양을 두 곳에 쓴다.
- 개인 배치: /api/me/prefs 의 `dash.layout` (사용자가 편집 모드에서 바꾸면 즉시 저장, 기기 간 동기화)
- 관리자 기본 배치: 관리 › 설정 › 대시보드 → appcfg `dash.layout` (/api/health config 로 모두에게 공개 — 비밀 아님)

모양:
    {"v": 1, "order": [카드 키…], "hidden": [카드 키…], "size": {카드 키: 1|2}, "locked": [카드 키…]}
- order: 보이는 순서. 모르는 키·중복은 버린다(프런트가 없는 키를 기본 순서 자리에 끼운다).
- hidden: 숨긴 카드. size: 1칸/2칸(열이 1이면 화면이 1칸으로 줄인다).
- locked: 관리자 고정 카드 — 관리자 기본 배치에서만 뜻이 있다(사용자는 숨김·크기 불가, 순서만).
  개인 배치에 들어온 locked 는 버린다.
"""

from __future__ import annotations

# 프런트 lib/dashLayout.ts CARD_KEYS 와 같아야 한다
CARD_KEYS = (
    "start", "inbox", "today", "ai", "cont", "tasks", "mail", "later", "team", "git",
    "board", "notice", "chans", "store", "meet", "discover",
    # 네트워크 랩(NETLAB_URL 이 있을 때만 프런트가 쓸 수 있는 카드로 친다)
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
    """검사해서 정규화한 배치를 돌려준다. 객체가 아니면 ValueError."""
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
