"""세션 컨테이너에 들어가는 정책 파일 — Chromium 관리 정책(JSON) · KasmVNC 설정(YAML) · 환경변수.

순수 함수만 둔다(테스트가 바로 본다). 파일은 service 가 세션별 임시 디렉터리에 써서 읽기 전용으로 마운트한다.

Chromium 정책 경로: /etc/chromium/policies/managed/*.json (kasmweb/chromium 이미지가 같은 폴더에
urlblocklist.json(file://* 차단)·default_managed_policy.json 을 두고 있다 — 우리 파일은 거기에 더해진다.
같은 키가 겹치면 Chromium 은 파일 이름 순으로 뒤의 것이 이긴다 → 우리 파일 이름을 'zz-rbi-policy.json' 으로 둔다).
"""
from __future__ import annotations

import ipaddress
import json
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,30}$")
_HOST_RE = re.compile(r"^[A-Za-z0-9.-]+(:\d{1,5})?$")


@dataclass
class TargetPolicy:
    """대상 하나의 정책 묶음(모델 RbiTarget 의 정책 열과 1:1)."""

    url: str
    allowed_hosts: list[str] = field(default_factory=list)
    clipboard_to_browser: bool = True
    clipboard_from_browser: bool = True
    downloads: bool = False
    uploads: bool = False
    idle_minutes: int = 15
    max_hours: int = 8
    cpu: float = 2.0
    memory_mb: int = 2048
    #: pixel | mirror — 대상의 기본 화면 방식
    mode: str = "pixel"


def validate_key(key: str) -> str:
    k = (key or "").strip().lower()
    if not _KEY_RE.match(k):
        raise ValueError("식별자는 소문자·숫자·하이픈 2~31자(첫 글자는 소문자·숫자)여야 합니다")
    return k


def normalize_url(raw: str) -> str:
    """대상 주소 검증 — http(s), 호스트는 IP 또는 이름, 자격증명·쿼리 금지."""
    u = (raw or "").strip()
    if not u:
        raise ValueError("주소를 입력하세요")
    if "://" not in u:
        u = "http://" + u
    p = urlsplit(u)
    if p.scheme not in ("http", "https"):
        raise ValueError("주소는 http 또는 https 여야 합니다")
    if not p.hostname:
        raise ValueError("주소에 호스트가 없습니다")
    if p.username or p.password:
        raise ValueError("주소에 사용자 정보를 넣을 수 없습니다")
    if p.query or p.fragment:
        raise ValueError("주소에 쿼리·프래그먼트는 넣을 수 없습니다")
    if p.port is not None and not (1 <= p.port <= 65535):
        raise ValueError("포트가 올바르지 않습니다")
    return u.rstrip("/") if not p.path or p.path == "/" else u


def target_host(url: str) -> str:
    """URL 의 호스트(IP 또는 이름). 정책·netfilter 표시에 쓴다."""
    return urlsplit(url).hostname or ""


def target_is_private_ip(url: str) -> bool:
    """대상이 사설 IP 인가 — 격리 브라우저의 본래 목적(내부 자산)인지 관리자 화면에서 알려 준다."""
    try:
        return ipaddress.ip_address(target_host(url)).is_private
    except ValueError:
        return False


def normalize_hosts(hosts: list[str] | None, url: str) -> list[str]:
    """허용 호스트 목록 정리 — 비면 url 의 호스트 하나. 각 항목은 host[:port]."""
    out: list[str] = []
    for h in hosts or []:
        h = (h or "").strip()
        if not h:
            continue
        if not _HOST_RE.match(h):
            raise ValueError(f"허용 호스트 형식이 올바르지 않습니다: {h}")
        if h not in out:
            out.append(h)
    base = urlsplit(url)
    base_host = base.hostname or ""
    if base.port:
        base_host = f"{base_host}:{base.port}"
    if base_host and base_host not in out:
        out.insert(0, base_host)
    return out


def chromium_policy(p: TargetPolicy) -> dict:
    """Chromium 관리 정책 — 대상 호스트만 열리고, 확장·개발자도구·비밀번호 저장·동기화·인쇄를 끈다.

    URLBlocklist "*" 뒤에 URLAllowlist 가 이긴다(Chromium 정책 규칙). chrome:// 도 막히므로
    chrome://newtab 과 about:blank 만 허용해 빈 탭이 열려도 오류 화면이 안 뜨게 한다.
    """
    hosts = normalize_hosts(p.allowed_hosts, p.url)
    allow = []
    for h in hosts:
        allow.append(h)  # 스킴 무관(http·https 둘 다)
    allow += ["chrome://newtab", "about:blank"]
    pol: dict = {
        "URLBlocklist": ["*"],
        "URLAllowlist": allow,
        "HomepageLocation": p.url,
        "HomepageIsNewTabPage": False,
        "RestoreOnStartup": 4,
        "RestoreOnStartupURLs": [p.url],
        "NewTabPageLocation": p.url,
        # 확장·개발자도구·원격 디버깅
        "ExtensionInstallBlocklist": ["*"],
        "DeveloperToolsAvailability": 2,
        "RemoteDebuggingAllowed": False,
        # 자격증명·프로필·동기화
        "PasswordManagerEnabled": False,
        "AutofillAddressEnabled": False,
        "AutofillCreditCardEnabled": False,
        "BrowserSignin": 0,
        "SyncDisabled": True,
        "BrowserAddPersonEnabled": False,
        "BrowserGuestModeEnabled": False,
        "SavingBrowserHistoryDisabled": True,
        "IncognitoModeAvailability": 1,
        # 바깥으로 나가는 것들
        "MetricsReportingEnabled": False,
        "SafeBrowsingProtectionLevel": 0,
        "TranslateEnabled": False,
        "SpellCheckServiceEnabled": False,
        "AlternateErrorPagesEnabled": False,
        "SearchSuggestEnabled": False,
        "NetworkPredictionOptions": 2,
        "PromotionalTabsEnabled": False,
        "BackgroundModeEnabled": False,
        "DefaultBrowserSettingEnabled": False,
        "CommandLineFlagSecurityWarningsEnabled": False,
        # 장치·권한
        "AudioCaptureAllowed": False,
        "VideoCaptureAllowed": False,
        "ScreenCaptureAllowed": False,
        "DefaultGeolocationSetting": 2,
        "DefaultNotificationsSetting": 2,
        "DefaultWebBluetoothGuardSetting": 2,
        "DefaultWebUsbGuardSetting": 2,
        "DefaultSerialGuardSetting": 2,
        "DefaultFileSystemReadGuardSetting": 2,
        "DefaultFileSystemWriteGuardSetting": 2,
        # 인쇄는 "PDF 로 저장" 이라는 다운로드 우회 경로다
        "PrintingEnabled": bool(p.downloads),
        # 다운로드·업로드
        "DownloadRestrictions": 0 if p.downloads else 3,
        "DownloadDirectory": "/home/kasm-user/Downloads",
        "PromptForDownloadLocation": False,
        "AllowFileSelectionDialogs": bool(p.uploads),
    }
    return pol


def chromium_policy_json(p: TargetPolicy) -> str:
    return json.dumps(chromium_policy(p), ensure_ascii=False, indent=2) + "\n"


def kasmvnc_yaml(p: TargetPolicy) -> str:
    """KasmVNC 서버 설정(/etc/kasmvnc/kasmvnc.yaml 을 통째로 대체).

    이미지 기본값(자가서명 pem 경로·runtime_configuration)은 그대로 두고 DLP(클립보드)·자동 종료를 더한다.
    - no_user_session_timeout: 뷰어가 아무도 붙어 있지 않은 채로 N초 → 서버 종료 → 컨테이너 종료(KASMVNC_AUTO_RECOVER=false)
    - inactive_user_session_timeout: 붙어 있지만 입력이 없는 N초 → 같음
    백엔드 reaper 는 이걸 믿지 않고 last_seen·수명으로 한 번 더 거둔다(docs/rbi.md "유휴").
    """
    idle = max(60, int(p.idle_minutes) * 60)
    s2c = "true" if p.clipboard_from_browser else "false"
    c2s = "true" if p.clipboard_to_browser else "false"
    return (
        "network:\n"
        "  ssl:\n"
        "    pem_certificate: ${HOME}/.vnc/self.pem\n"
        "    pem_key: ${HOME}/.vnc/self.pem\n"
        "  udp:\n"
        "    public_ip: 127.0.0.1\n"
        "runtime_configuration:\n"
        "  allow_override_standard_vnc_server_settings: true\n"
        "  allow_override_list:\n"
        "    - pointer.enabled\n"
        "user_session:\n"
        "  concurrent_connections_prompt: false\n"
        "server:\n"
        "  auto_shutdown:\n"
        f"    no_user_session_timeout: {idle}\n"
        f"    inactive_user_session_timeout: {idle}\n"
        "    active_user_session_timeout: never\n"
        "data_loss_prevention:\n"
        "  clipboard:\n"
        "    delay_between_operations: none\n"
        "    allow_mimetypes:\n"
        "      - chromium/x-web-custom-data\n"
        "      - text/html\n"
        "      - image/png\n"
        "    server_to_client:\n"
        f"      enabled: {s2c}\n"
        "      size: unlimited\n"
        "      primary_clipboard_enabled: false\n"
        "    client_to_server:\n"
        f"      enabled: {c2s}\n"
        "      size: unlimited\n"
        "  logging:\n"
        "    level: off\n"
    )


def container_env(p: TargetPolicy, vnc_password: str) -> dict[str, str]:
    """세션 컨테이너 환경변수 — 보조 서비스는 모두 끄고, 정책 파일 본문(RBI_POLICY_JSON·RBI_KASMVNC_YAML)을 함께 넘긴다.
    자세한 설명은 아래 _base_env. 두 정책 텍스트는 시작 셸이 tmpfs 파일로 쓴 뒤 unset 한다."""
    env = _base_env(p, vnc_password)
    env["RBI_POLICY_JSON"] = chromium_policy_json(p)
    env["RBI_KASMVNC_YAML"] = kasmvnc_yaml(p)
    return env


def _base_env(p: TargetPolicy, vnc_password: str) -> dict[str, str]:
    """세션 컨테이너 환경변수 — 보조 서비스(오디오·업로드 서버·프린터·스마트카드·웹캠·게임패드)는 모두 끈다.

    KASM_SVC_SEND_CUT_TEXT / ACCEPT_CUT_TEXT 는 이미지의 vnc_startup.sh 가 Xvnc 명령줄에 그대로 붙이는 값이다
    (명령줄이 yaml 보다 우선) — 클립보드 정책을 두 겹으로 건다.
    """
    env = {
        "VNC_PW": vnc_password,
        "LAUNCH_URL": p.url,
        "KASMVNC_AUTO_RECOVER": "false",          # Xvnc 가 자동 종료(유휴)로 끝나면 컨테이너도 끝난다
        "START_PULSEAUDIO": "0",
        "KASM_SVC_AUDIO": "0",
        "KASM_SVC_AUDIO_INPUT": "0",
        "KASM_SVC_UPLOADS": "1" if p.uploads else "0",
        "KASM_SVC_GAMEPAD": "0",
        "KASM_SVC_WEBCAM": "0",
        "KASM_SVC_PRINTER": "0",
        "KASM_SVC_SMARTCARD": "0",
        "KASM_SVC_RECORDER": "0",
        "KASM_SVC_SEND_CUT_TEXT": "-SendCutText 1" if p.clipboard_from_browser else "-SendCutText 0",
        "KASM_SVC_ACCEPT_CUT_TEXT": "-AcceptCutText 1" if p.clipboard_to_browser else "-AcceptCutText 0",
        "MAX_FRAME_RATE": "24",
        "VNC_RESOLUTION": "1600x900",
        "TZ": "Asia/Seoul",
    }
    return env


def docker_create_args(
    *,
    name: str,
    network: str,
    publish_ip: str,
    image: str,
    env: dict[str, str],
    cpu: float,
    memory_mb: int,
    dns: str = "0.0.0.0",
    add_hosts: list[str] | None = None,
) -> list[str]:
    """`docker create` 인자 — 비루트(uid 1000)·읽기 전용 루트·cap_drop ALL·no-new-privileges·자원 상한.

    정책 파일(Chromium 관리 정책·kasmvnc.yaml)은 환경변수(RBI_POLICY_JSON·RBI_KASMVNC_YAML)로 넘기고, 그 두 디렉터리를
    tmpfs 로 덮은 뒤 시작 셸이 파일로 써 놓고 이미지 원래 시작 체인(kasm_default_profile → vnc_startup → kasm_startup)을
    exec 한다. 백엔드는 컨테이너 안이라 호스트 경로 바인드를 못 쓰고, 읽기 전용 루트는 start 전 `docker cp` 도 거부한다.
    쓰기가 필요한 곳만 tmpfs(홈·/tmp·/var/run·/var/log·시작 로그). 홈은 세션이 끝나면 함께 사라진다.
    포트는 `publish_ip::6901`(호스트가 빈 포트를 고른다) — ws-nginx 만 닿는 workspace 브리지 게이트웨이 주소.
    DNS 는 응답할 수 없는 주소로 보내 이름 풀이가 늘 실패하게 한다(embedded DNS 가 호스트 리졸버로 새는 길 차단).
    """
    args = [
        "create", "--name", name,
        "--hostname", "rbi",
        "--network", network,
        "--publish", f"{publish_ip}::6901",
        "--dns", dns,
        "--user", "1000:1000",
        "--read-only",
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
        "--tmpfs", "/home/kasm-user:rw,nosuid,nodev,uid=1000,gid=1000,size=512m",
        "--tmpfs", "/var/run:rw,nosuid,nodev,size=16m",
        "--tmpfs", "/var/log:rw,nosuid,nodev,size=16m",
        "--tmpfs", "/dockerstartup/logs:rw,nosuid,nodev,size=16m",
        # 정책 파일 자리 — 이미지의 urlblocklist.json(file://*)·default_managed_policy.json 은 가려지지만 같은 내용이 우리 정책에 들어 있다
        "--tmpfs", "/etc/chromium/policies/managed:rw,nosuid,nodev,uid=1000,gid=1000,size=1m",
        "--tmpfs", "/etc/kasmvnc:rw,nosuid,nodev,uid=1000,gid=1000,size=1m",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--shm-size", "512m",
        "--cpus", str(cpu),
        "--memory", f"{int(memory_mb)}m",
        "--memory-swap", f"{int(memory_mb)}m",
        "--pids-limit", "512",
        "--sysctl", "net.ipv6.conf.all.disable_ipv6=1",
        "--restart", "no",
        "--label", "app.just-workspace.rbi=session",
    ]
    # 이름으로 적은 대상 → 저장할 때 고정한 IP(--add-host). DNS 가 없으니 이 이름들만 풀린다(app/rbi/egress.py)
    args += list(add_hosts or [])
    for k, v in env.items():
        args += ["-e", f"{k}={v}"]
    args += ["--entrypoint", "/bin/bash", image, "-c", STARTUP_SCRIPT]
    return args


#: 세션 컨테이너 시작 셸 — 정책 파일을 tmpfs 에 쓰고(비밀 아님) 이미지 원래 시작 체인을 그대로 exec
STARTUP_SCRIPT = (
    "umask 022; "
    "printf '%s' \"$RBI_POLICY_JSON\" > /etc/chromium/policies/managed/zz-rbi-policy.json; "
    "printf '%s' \"$RBI_KASMVNC_YAML\" > /etc/kasmvnc/kasmvnc.yaml; "
    "unset RBI_POLICY_JSON RBI_KASMVNC_YAML; "
    "exec /dockerstartup/kasm_default_profile.sh /dockerstartup/vnc_startup.sh /dockerstartup/kasm_startup.sh --wait"
)


# ── 미러 모드(DOM 재구성, 세션 이미지 just-workspace-rbi-mirror — rbi/mirror/) ──
# 같은 세션 배관(게시 포트 6901·br-wsrbi·netfilter·auth_request)을 그대로 쓰고 컨테이너 안만 바뀐다:
# KasmVNC 대신 mirror-agent(Node) 가 Chromium 을 --remote-debugging-pipe 로 소유하고 6901(평문 HTTP+WS, 브리지 안 한 홉)에서
# view · mirror · asset/<sha> · font/<file> · download/<id> · upload/<id> 를 낸다.
# 사용자 PC 로는 닫힌 어휘(JSON)·재인코딩 WebP·인셋 WebP·고정 폰트 묶음만 간다. 클립보드·다운로드·업로드 정책은 에이전트가 강제한다.

MODES = ("pixel", "mirror")
MIRROR_HOME = "/home/node"


def validate_mode(mode: str | None) -> str:
    m = (mode or "pixel").strip().lower()
    if m not in MODES:
        raise ValueError("화면 방식은 pixel 또는 mirror")
    return m


def mirror_chromium_policy(p: TargetPolicy) -> dict:
    """미러 모드 Chromium 정책 — 픽셀 모드와 같되 세 가지만 다르다(URL 허용목록·확장·자격증명·장치 잠금은 그대로).

    - RemoteDebuggingAllowed: True — 에이전트가 CDP 파이프(--remote-debugging-pipe)로 붙어야 한다. 포트는 열지 않으므로
      바깥에서 디버거에 닿을 길은 없다(파이프는 부모 프로세스=에이전트의 fd 3/4).
    - DeveloperToolsAvailability: 1 — 2(금지)면 CDP 가 페이지 타깃에 붙지 못해 에이전트가 영원히 기다린다(Target.setAutoAttach 뒤
      첫 페이지가 안 온다). 헤드리스라 개발자도구 UI 를 열 사람이 없다 — 1 이어도 사용자 표면은 같다.
    - DownloadDirectory: 미러 이미지의 홈(에이전트가 받은 파일을 정책이 허용할 때만 /download/<id> 로 내준다).
    """
    pol_ = chromium_policy(p)
    pol_["RemoteDebuggingAllowed"] = True
    pol_["DeveloperToolsAvailability"] = 1
    pol_["DownloadDirectory"] = f"{MIRROR_HOME}/Downloads"
    return pol_


def mirror_agent_policy(p: TargetPolicy) -> dict:
    """에이전트가 강제하는 정책(MIRROR_POLICY) — ci: 내 PC→브라우저 붙여넣기, co: 브라우저→내 PC 복사, dl·ul: 다운로드·업로드."""
    return {"ci": bool(p.clipboard_to_browser), "co": bool(p.clipboard_from_browser), "dl": bool(p.downloads), "ul": bool(p.uploads)}


def mirror_container_env(p: TargetPolicy, *, sid: str, auth_header: str = "") -> dict[str, str]:
    """미러 세션 컨테이너 env — 에이전트 설정 + Chromium 정책 본문(시작 셸이 tmpfs 파일로 쓴 뒤 unset).

    auth_header: ws-nginx 가 auth_request 응답(X-Rbi-Authorization)으로 받아 붙이는 값과 같은 "Basic …".
    에이전트는 /healthz 말고는 이 값이 없는 요청을 401 로 거절하고, 읽은 뒤 자기 환경에서 지운다(Chromium 자식에 물려주지 않게).
    MIRROR_ALLOW 는 Chromium URLAllowlist 와 같은 호스트 목록 — 막힌 이동을 신뢰 크롬에 알리는 데 쓴다(차단 자체는 Chromium 정책).
    MIRROR_IDLE_SECONDS: 뷰어가 없거나 입력이 없는 시간이 이만큼이면 에이전트가 끝난다(컨테이너 종료 → reaper 가 container_exited).
    """
    return {
        "MIRROR_AUTH": auth_header,
        "MIRROR_URL": p.url,
        "MIRROR_PORT": "6901",
        "MIRROR_SID": sid,
        "MIRROR_CHROMIUM": "/usr/bin/chromium",
        "MIRROR_VIEWPORT": "1600x900",
        "MIRROR_POLICY": json.dumps(mirror_agent_policy(p)),
        "MIRROR_ALLOW": json.dumps(normalize_hosts(p.allowed_hosts, p.url)),
        "MIRROR_IDLE_SECONDS": str(max(60, int(p.idle_minutes) * 60)),
        "TZ": "Asia/Seoul",
        # UTF-8 로캘 — 없으면 Chromium 이 한글 이름 파일을 올리기에서 조용히 버린다. 이미지 ENV 와 같은 값(두 겹)
        "LANG": "C.UTF-8",
        "RBI_POLICY_JSON": json.dumps(mirror_chromium_policy(p), ensure_ascii=False, indent=2) + "\n",
    }


#: 미러 세션 시작 셸 — 정책을 tmpfs 에 쓰고 에이전트를 exec(에이전트가 Chromium 을 자식으로 띄운다)
MIRROR_STARTUP_SCRIPT = (
    "umask 022; "
    "printf '%s' \"$RBI_POLICY_JSON\" > /etc/chromium/policies/managed/zz-rbi-policy.json; "
    "unset RBI_POLICY_JSON; "
    "exec node /opt/mirror/agent/dist/agent/src/index.js"
)


def mirror_docker_create_args(
    *,
    name: str,
    network: str,
    publish_ip: str,
    image: str,
    env: dict[str, str],
    cpu: float,
    memory_mb: int,
    dns: str = "0.0.0.0",
    add_hosts: list[str] | None = None,
) -> list[str]:
    """미러 세션 `docker create` 인자 — 픽셀 모드(docker_create_args)와 같은 잠금(비루트·읽기 전용·cap 없음·자원 상한·DNS 없음·IPv6 끔).

    다른 점: 이미지의 node 사용자(uid 1000), tmpfs 는 /tmp(Chromium 프로필·내려받기·올리기)·홈·정책 폴더만(KasmVNC 경로 없음),
    포트는 같은 6901 이라 netfilter 의 "ws-nginx → 6901" 규칙과 게시 포트 조회(published_upstream)를 그대로 쓴다.
    라벨 app.just-workspace.rbi=session 은 같다(reaper 가 고아로 거둔다).
    """
    args = [
        "create", "--name", name,
        "--hostname", "rbi",
        "--network", network,
        "--publish", f"{publish_ip}::6901",
        "--dns", dns,
        "--user", "1000:1000",
        "--read-only",
        "--tmpfs", "/tmp:rw,nosuid,nodev,size=512m",
        "--tmpfs", f"{MIRROR_HOME}:rw,nosuid,nodev,uid=1000,gid=1000,size=256m",
        "--tmpfs", "/etc/chromium/policies/managed:rw,nosuid,nodev,uid=1000,gid=1000,size=1m",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true",
        "--shm-size", "512m",
        "--cpus", str(cpu),
        "--memory", f"{int(memory_mb)}m",
        "--memory-swap", f"{int(memory_mb)}m",
        "--pids-limit", "512",
        "--sysctl", "net.ipv6.conf.all.disable_ipv6=1",
        "--restart", "no",
        "--label", "app.just-workspace.rbi=session",
        "--label", "app.just-workspace.rbi.mode=mirror",
    ]
    args += list(add_hosts or [])
    for k, v in env.items():
        args += ["-e", f"{k}={v}"]
    args += ["--entrypoint", "/bin/sh", image, "-c", MIRROR_STARTUP_SCRIPT]
    return args
