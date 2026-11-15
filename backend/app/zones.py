"""구역(zone) — 설치된 구역만 API 라우터와 백그라운드 루프를 올린다.

선언은 두 곳으로 나뉜다.

- `zones.json`(이 파일 옆): 구역 id 와 그 구역이 소유한 modules 의 단일 출처.
  설치 마법사·설치 관리자도 같은 파일을 읽는다.
- 이 파일의 `ROUTERS` · `LOOPS` · `SOCKET_HANDLERS`: 어느 라우터·루프가 어느 구역 것인지. 라우터는 등록
  순서가 경로 매칭에 영향을 주므로(같은 prefix, catch-all) 구역별로 흩지 않고 **등록
  순서 그대로 한 줄로** 둔다. 표의 구역 이름이 zones.json 에 있는지, 문자열이 실제로
  import 되는지는 tests/test_zones.py 가 지킨다.

설치된 구역은 환경변수 `JW_ZONES`(쉼표 구분 구역 id)로 정한다. 없거나 비어 있으면
전부 설치된 것으로 본다. core 는 늘 설치돼 있다.
"""

from __future__ import annotations

import importlib
import json
import logging
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

ENV_VAR = "JW_ZONES"
CORE = "core"
_ZONES_FILE = Path(__file__).with_name("zones.json")


# ─── 선언(zones.json) ───


@lru_cache(maxsize=1)
def load_zones() -> dict[str, Any]:
    """zones.json 전체(캐시)."""
    with _ZONES_FILE.open(encoding="utf-8") as f:
        return json.load(f)


@lru_cache(maxsize=1)
def all_zone_ids() -> tuple[str, ...]:
    """고를 수 있는 구역 id — zones 다음 addons, 선언 순서. core 는 넣지 않는다."""
    data = load_zones()
    return tuple(z["id"] for z in (*data.get("zones", []), *data.get("addons", [])))


@lru_cache(maxsize=1)
def _module_owner() -> dict[str, str]:
    """모듈 id → 그 모듈을 소유한 구역 id(core 포함)."""
    data = load_zones()
    owner: dict[str, str] = {}
    for zone in (data["core"], *data.get("zones", []), *data.get("addons", [])):
        for module_id in zone.get("modules", []):
            owner.setdefault(module_id, zone["id"])
    return owner


# ─── 설치된 구역(JW_ZONES) ───


@lru_cache(maxsize=16)
def _parse_installed(raw: str) -> frozenset[str]:
    """JW_ZONES 값 → 설치된 구역 집합. 값이 같으면 다시 풀지 않는다(경고도 한 번만)."""
    known = all_zone_ids()
    wanted = [part.strip().lower() for part in raw.split(",") if part.strip()]
    if not wanted:
        return frozenset(known)
    installed: set[str] = set()
    for zone_id in wanted:
        if zone_id == CORE:
            continue  # 늘 설치돼 있다 — 적어도 되고 안 적어도 된다
        if zone_id in known:
            installed.add(zone_id)
        else:
            logger.warning("[zones] %s 에 알 수 없는 구역 id %r — 무시합니다", ENV_VAR, zone_id)
    return frozenset(installed)


def installed_zones() -> set[str]:
    """설치된 구역 id 집합(core 는 빼고). JW_ZONES 가 없거나 비면 전부."""
    return set(_parse_installed(os.environ.get(ENV_VAR, "")))


def installed_zone_ids() -> list[str]:
    """설치된 구역 id — zones.json 선언 순서."""
    installed = installed_zones()
    return [zone_id for zone_id in all_zone_ids() if zone_id in installed]


def zone_installed(zone_id: str) -> bool:
    """구역이 설치돼 있는가. core 는 늘 True, 모르는 id 는 False."""
    return zone_id == CORE or zone_id in installed_zones()


def requirement_met(requirement: str) -> bool:
    """표의 구역 조건 — "mail" 처럼 하나, 또는 "chat+meetings" 처럼 모두 설치돼야 하는 묶음."""
    return all(zone_installed(zone_id) for zone_id in requirement.split("+"))


def module_installed(module_id: str) -> bool:
    """그 모듈이 속한 구역이 설치돼 있는가.

    core 의 모듈은 늘 True. zones.json 어디에도 없는 모듈 id(플러그인 모듈 등)도 True —
    구역이 소유하지 않은 것은 구역 설치 여부로 막지 않는다.
    """
    owner = _module_owner().get(module_id)
    return owner is None or zone_installed(owner)


# ─── 구역별 라우터·루프 표 ───
#
# (구역 조건, "모듈경로:속성") — 위에서 아래로, 등록 순서 그대로. 조건은 구역 id 하나,
# 또는 "+" 로 이은 여러 구역(모두 설치돼야 함).

ROUTERS: list[tuple[str, str]] = [
    ("core", "app.modules.router:router"),
    ("core", "app.auth.router:router"),
    ("core", "app.auth.devices_router:router"),      # 기기 등록·해지 (데스크톱 클라이언트)
    ("core", "app.auth.me_sessions:router"),         # 내 로그인 기기(세션) 목록·끊기
    ("core", "app.auth.me_security:router"),         # 내 연결된 앱(OAuth)·앱 비밀번호
    ("core", "app.auth.two_factor:router"),          # 2단계 인증 상태·복구 코드
    ("core", "app.auth.recovery_email:router"),      # 복구 이메일 변경
    ("core", "app.auth.internal_router:router"),     # 내부 서비스 전용(도커망 한정, 키 필요)
    ("core", "app.middleware.csp_report:router"),    # CSP Report-Only 위반 수집
    ("core", "app.middleware.client_error:router"),  # 화면 쪽 오류(오류 화면 요청 번호) 수집
    ("core", "app.auth.oauth_provider:router"),
    ("core", "app.auth.oauth_provider:root_router"),  # 루트 .well-known discovery
    ("core", "app.auth.ldap_router:router"),
    ("core", "app.services.router:router"),
    ("core", "app.files.router:router"),
    ("core", "app.files.comments:router"),           # 파일 댓글
    ("mail", "app.mail.router:router"),
    ("mail", "app.mail.oauth:router"),
    ("mail", "app.mail.client_setup:router"),        # 외부 메일 앱 안내·애플 구성 프로필
    ("mail", "app.mail.client_setup:root_router"),   # autoconfig·autodiscover(루트 경로)
    ("ai", "app.ai.inline_router:router"),           # 화면 안 AI(메일·채팅·회의·문서)
    ("ai", "app.ai.router:router"),
    ("core", "app.backup.router:router"),
    ("core", "app.groups.router:router"),
    ("core", "app.apps.router:router"),
    ("core", "app.admin.router:router"),
    ("core", "app.admin.users_ext:router"),          # 관리 사용자 일괄·삭제·초대·운영 요약
    ("core", "app.admin.settings_ext:router"),       # 관리 로그인 보호 정책·저장소 요약·사용자 할당
    ("core", "app.system.router:router"),            # 관리 › 구역 켜기·끄기·설정(설치 관리자 대신 호출) · 저장소 상태
    ("core", "app.system.router:public_router"),     # 파일 탭·알림 띠 — 저장소에 닿는가
    ("core", "app.system.update_router:router"),           # 관리 › 업데이트(설치 관리자 대신 호출)
    ("core", "app.system.update_router:public_router"),    # 업데이트 예고·점검 상태(로그인한 누구나)
    ("core", "app.system.update_router:internal_router"),  # 설치 관리자가 예고·점검을 알려 오는 경로(키 필요)
    ("core", "app.setup.router:router"),
    ("git", "app.git.router:router"),
    ("core", "app.dashboard.router:router"),
    ("core", "app.dashboard.checklist:router"),      # 시작 체크리스트
    ("mail", "app.mail.sender:router"),              # 메일 보낸 사람 카드
    ("core", "app.dashboard.cards:router"),          # 대시보드 카드(자주 쓰는 채널 · 최근 위키)
    ("core", "app.dashboard.home:router"),           # 홈: 이어서 하기 · 팀 · 내 저장 공간
    ("ai", "app.dashboard.briefing:router"),         # 홈 AI 브리핑(옵트인)
    ("calendar", "app.calendar.router:router"),
    ("calendar", "app.contacts.router:router"),
    ("meetings", "app.meetings.router:router"),
    ("meetings", "app.meetings.calls:router"),
    ("chat", "app.chat.router:router"),
    ("chat", "app.chat.tabs:router"),                # 채널 탭(파일·위키·회의·작업)
    ("chat", "app.chat.roles:router"),               # 역할·권한·카테고리
    ("chat", "app.chat.router22:router"),            # 첨부 묶음·스레드·이모지·검색·프로필·정책
    ("chat+meetings", "app.chat.voice:router"),      # 음성 채널(토큰·접속 상태) — 회의 서버가 있어야 한다
    ("core", "app.realtime.socket:router"),          # 실시간 소켓(/ws/chat) — 알림·배지 등 전 구역이 쓴다
    ("chat+meetings", "app.chat.voice_relay:router"),  # 음성 채널 무손실 티어 — 릴레이 토큰
    ("chat", "app.chat.webhook:router"),
    ("docs", "app.board.router:router"),
    ("calendar", "app.tasks.router:router"),
    ("core", "app.search.router:router"),
    ("core", "app.plugins.router:router"),
    ("core", "app.push.router:router"),
    ("docs", "app.wiki.router:router"),
    ("docs", "app.wiki.collab:router"),
    ("docs", "app.wopi.router:router"),
    ("docs", "app.wopi.share:router"),               # 새 문서 · 공유 링크로 같이 편집
    ("core", "app.notifications.router:router"),
    ("core", "app.me.prefs:router"),                 # 개인 설정 서버 저장 (/api/me/prefs)
    ("core", "app.privacy.router:router"),
    # MCP 커넥터 관리(개인 토큰·OAuth 연결). prefix /api/ai-connect 는 /api/mcp 밖이라
    # 기동 때 붙는 MCP Streamable-HTTP Mount("/api/mcp", …) 에 가려지지 않는다.
    ("ai", "app.mcp.account_router:router"),
    ("ai", "app.mcp.usage_router:router"),           # 관리자 › AI 운영(사용량·감사)
    ("ai", "app.ai.feedback_admin:router"),          # 관리자 › AI 운영 › 피드백
    ("ai", "app.mcp.approvals_router:router"),       # AI 쓰기 승인 대기함·채팅 승인 카드
    ("ai", "app.ai.artifacts_router:router"),        # AI 결과물(문서·묶음·파일 압축·만료 링크)
    ("rbi", "app.rbi.router:router"),                # 격리 브라우저 — 세션·대상·nginx auth_request
    ("rbi", "app.rbi.site:router"),                  # 격리 브라우저 전용 출처 — SSO 홉·rbi 세션
]

# 백그라운드 루프 — lifespan 이 위에서 아래로 시작한다. 인자 없는 코루틴 함수여야 한다.
LOOPS: list[tuple[str, str]] = [
    ("core", "app.services.health:run_health_checker"),
    ("core", "app.files.indexer:run_indexer"),               # 파일 검색 색인
    ("core", "app.middleware.access_log:run_log_flusher"),
    ("core", "app.middleware.access_log:run_log_cleanup"),
    ("calendar", "app.main:_reminder_loop"),                 # 일정 알림
    ("mail", "app.mail.poller:run_poller"),                  # 메일 인박스 폴러(새 메일 이벤트)
    ("core", "app.main:_backup_loop"),                       # 예약 백업
    ("meetings", "app.meetings.calls:run_call_state_loop"),  # 채널 통화 상태 대조(웹훅 누락 보정)
    ("core", "app.files.retention:run_retention"),           # 버전·휴지통·업로드 세션 만료 정리
    ("core", "app.db.redis_handoff:run_handoff"),            # 예전에 Redis 에만 있던 값을 DB 로(기동 뒤 한 번)
    ("mail", "app.mail.scheduled:run_scheduled_sender"),     # 예약 메일 발송
    ("calendar", "app.main:_calendar_subscription_loop"),    # 외부 캘린더 구독(.ics) 갱신
    ("rbi", "app.rbi.service:run_reaper"),                   # 격리 브라우저 세션 거두기
    ("ai", "app.ai.ops_retention:run_ai_retention"),         # AI 감사 기록·피드백 스냅샷 정리
]

# 실시간 소켓(app/realtime/socket.py)이 클라이언트에게서 받는 프레임의 처리기.
# 대상은 {프레임 종류(type): 처리기} 사전 — 설치된 구역 것만 합쳐서 쓴다.
SOCKET_HANDLERS: list[tuple[str, str]] = [
    ("chat", "app.chat.ws_handlers:HANDLERS"),               # 메시지 전송·반응·타이핑·읽음
]


def resolve(target: str) -> Any:
    """"모듈경로:속성" 문자열을 실제 객체로."""
    module_name, _, attr = target.partition(":")
    return getattr(importlib.import_module(module_name), attr)


def active_routers() -> list[Any]:
    """설치된 구역의 라우터 — 등록 순서 그대로. 미설치 구역의 모듈은 import 하지 않는다."""
    return [resolve(target) for requirement, target in ROUTERS if requirement_met(requirement)]


def active_loops() -> list[Any]:
    """설치된 구역의 백그라운드 루프 함수 — 시작 순서 그대로."""
    return [resolve(target) for requirement, target in LOOPS if requirement_met(requirement)]


@lru_cache(maxsize=16)
def _socket_handlers(installed: frozenset[str]) -> dict[str, Any]:
    """설치된 구역 집합별 처리기 사전(캐시) — 프레임마다 다시 만들지 않는다."""
    handlers: dict[str, Any] = {}
    for requirement, target in SOCKET_HANDLERS:
        if all(zone_id == CORE or zone_id in installed for zone_id in requirement.split("+")):
            handlers.update(resolve(target))
    return handlers


def active_socket_handlers() -> dict[str, Any]:
    """설치된 구역이 등록한 실시간 소켓 프레임 처리기 — {프레임 종류: 처리기}."""
    return _socket_handlers(frozenset(installed_zones()))
