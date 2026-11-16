"""확인(probe) — 화면의 "확인" 버튼들이 호출하는 기능.

외부에 접근하는 부분(DNS·HTTP·SMTP·docker)은 모두 인자로 전달받아 테스트에서 교체할 수 있다.
결과는 키와 값만 포함한다(문구는 화면 측이 보유).
"""

from __future__ import annotations

import ipaddress
import json
import secrets
import smtplib
import socket
import ssl
from collections import Counter
from typing import Callable, Protocol

from app import validators as v
from app.docker_api import Docker

GB = 1024 ** 3
NFS_FREE_WARN_GB = 10
BACKEND_UID_GID = "1000:1000"      # backend 컨테이너가 파일을 기록하는 사용자(backend/Dockerfile 의 appuser)

# 공인 주소 조회 대상 — 단일 서비스에 의존하지 않는다. 둘 이상의 응답이 일치해야 신뢰한다.
PUBLIC_IP_URLS = (
    "https://api.ipify.org",
    "https://checkip.amazonaws.com",
    "https://icanhazip.com",
    "https://ifconfig.me/ip",
)
AGREE_MIN = 2


# ─── 공인 주소 ───


_NOT_PUBLIC = tuple(ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
    "192.168.0.0/16", "224.0.0.0/4", "240.0.0.0/4",
))


def is_public_ipv4(value: str) -> bool:
    """인터넷에서 접근 가능한 형식의 IPv4 인지 여부(사설·통신사 NAT·루프백·링크로컬·멀티캐스트 제외)."""
    try:
        ip = ipaddress.IPv4Address(value.strip())
    except ValueError:
        return False
    return not any(ip in net for net in _NOT_PUBLIC)


def http_ip_fetcher(url: str) -> Callable[[], str | None]:
    def fetch() -> str | None:
        try:
            import httpx

            with httpx.Client(timeout=5.0, follow_redirects=True) as client:
                r = client.get(url, headers={"User-Agent": "curl/8"})
            return r.text.strip() if r.status_code == 200 else None
        except Exception:  # noqa: BLE001
            return None
    return fetch


def default_ip_fetchers() -> list[Callable[[], str | None]]:
    return [http_ip_fetcher(u) for u in PUBLIC_IP_URLS]


def detect_public_ip(fetchers: list[Callable[[], str | None]] | None = None,
                     local_address: str | None = None) -> dict:
    """{"status": detected|unknown, "ip", "agree", "asked"}.

    - 서버의 아웃바운드 주소(local_address)가 공인 주소이면 해당 값을 사용한다(NAT 없음).
    - 그 외에는 외부 서비스 여러 곳에 조회하고, 동일 응답이 둘 이상인 경우에만 신뢰한다.
    """
    if local_address and is_public_ipv4(local_address):
        return {"status": "detected", "ip": local_address, "agree": 1, "asked": 0, "source": "interface"}
    fetchers = default_ip_fetchers() if fetchers is None else fetchers
    answers: list[str] = []
    for fetch in fetchers:
        try:
            value = fetch()
        except Exception:  # noqa: BLE001
            value = None
        if value and is_public_ipv4(value):
            answers.append(value.strip())
            top, count = Counter(answers).most_common(1)[0]
            if count >= AGREE_MIN:
                return {"status": "detected", "ip": top, "agree": count, "asked": len(answers), "source": "services"}
    return {"status": "unknown", "ip": None, "agree": 0, "asked": len(answers), "source": None}


# ─── DNS ───


class Resolver(Protocol):
    def query(self, name: str, rtype: str) -> list[str]:
        """레코드 값 목록. 레코드가 없으면 빈 목록, 조회 자체가 실패하면 LookupError 발생."""


class DnsResolver:
    """dnspython — 시스템 설정의 DNS 서버에 조회한다."""

    def __init__(self, timeout: float = 5.0):
        self.timeout = timeout

    def query(self, name: str, rtype: str) -> list[str]:
        import dns.exception
        import dns.resolver

        resolver = dns.resolver.Resolver()
        resolver.lifetime = self.timeout
        try:
            answer = resolver.resolve(name, rtype)
        except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer):
            return []
        except dns.exception.DNSException as e:
            raise LookupError(str(e)) from e
        out = []
        for record in answer:
            if rtype == "TXT":
                out.append(b"".join(record.strings).decode("utf-8", "replace"))
            elif rtype == "MX":
                out.append(f"{record.preference} {str(record.exchange).rstrip('.').lower()}")
            else:
                out.append(str(record).rstrip("."))
        return out


def probe_dns(domain: str, public_ip: str | None, resolver: Resolver) -> dict:
    """접속 주소가 이 서버를 가리키는지 여부 — {"status": match|mismatch|unknown, "addresses", "public_ip", "reason"}."""
    name = v.address(domain)
    if v.is_ip(name):
        status = "match" if public_ip and name == public_ip else "unknown"
        return {"status": status, "addresses": [name], "public_ip": public_ip, "reason": "address_is_ip"}
    try:
        addresses = resolver.query(name, "A")
    except LookupError:
        return {"status": "unknown", "addresses": [], "public_ip": public_ip, "reason": "lookup_failed"}
    if not addresses:
        return {"status": "mismatch", "addresses": [], "public_ip": public_ip, "reason": "no_record"}
    if not public_ip:
        return {"status": "unknown", "addresses": addresses, "public_ip": None, "reason": "public_ip_unknown"}
    if public_ip in addresses:
        return {"status": "match", "addresses": addresses, "public_ip": public_ip, "reason": None}
    return {"status": "mismatch", "addresses": addresses, "public_ip": public_ip, "reason": "points_elsewhere"}


def _record(record_id: str, name: str, rtype: str, expected: str, current: list[str], status: str) -> dict:
    return {"id": record_id, "name": name, "type": rtype, "expected": expected, "current": current, "status": status}


def probe_mail_records(mail_domain: str, public_ip: str | None, dkim_value: str, resolver: Resolver,
                       selector: str = "default") -> dict:
    """메일 레코드 5개의 기대값과 현재값 — status: ok | missing | different | unknown."""
    d = v.domain(mail_domain)
    mail_host = f"mail.{d}"

    def lookup(name: str, rtype: str) -> list[str] | None:
        try:
            return resolver.query(name, rtype)
        except LookupError:
            return None

    records: list[dict] = []

    mx = lookup(d, "MX")
    expected_mx = f"10 {mail_host}"
    if mx is None:
        status = "unknown"
    elif not mx:
        status = "missing"
    else:
        status = "ok" if any(r.split(" ", 1)[-1].rstrip(".").lower() == mail_host for r in mx) else "different"
    records.append(_record("mx", d, "MX", expected_mx, mx or [], status))

    a = lookup(mail_host, "A")
    if a is None or (a and not public_ip):
        status = "unknown"
    elif not a:
        status = "missing"
    else:
        status = "ok" if public_ip in a else "different"
    records.append(_record("a", mail_host, "A", public_ip or "", a or [], status))

    txt = lookup(d, "TXT")
    spf = [t for t in (txt or []) if t.lower().startswith("v=spf1")]
    if txt is None:
        status = "unknown"
    elif not spf:
        status = "missing"
    else:
        terms = spf[0].lower().split()
        allows = "mx" in terms or "+mx" in terms or f"a:{mail_host}" in terms or (
            public_ip and f"ip4:{public_ip}" in terms)
        status = "ok" if allows and len(spf) == 1 else "different"
    records.append(_record("spf", d, "TXT", "v=spf1 mx ~all", spf, status))

    dkim_name = f"{selector}._domainkey.{d}"
    dk = lookup(dkim_name, "TXT")
    if dk is None:
        status = "unknown"
    elif not dk:
        status = "missing"
    else:
        def public_key(value: str) -> str:
            for part in value.replace(" ", "").split(";"):
                if part.startswith("p="):
                    return part[2:]
            return ""
        status = "ok" if any(public_key(r) == public_key(dkim_value) for r in dk) else "different"
    records.append(_record("dkim", dkim_name, "TXT", dkim_value, dk or [], status))

    dmarc_name = f"_dmarc.{d}"
    dm = lookup(dmarc_name, "TXT")
    if dm is None:
        status = "unknown"
    elif not dm:
        status = "missing"
    else:
        status = "ok" if any(r.replace(" ", "").lower().startswith("v=dmarc1") for r in dm) else "different"
    records.append(_record("dmarc", dmarc_name, "TXT", f"v=DMARC1; p=quarantine; rua=mailto:postmaster@{d}", dm or [], status))

    return {"mail_domain": d, "records": records, "ok": all(r["status"] == "ok" for r in records)}


# ─── 외부 SMTP ───


def probe_smtp(host: str, port: int, security: str, username: str, password: str, *, timeout: float = 10.0,
               smtp_factory=None) -> dict:
    """외부 SMTP 로그인 확인 — {"status": ok|unreachable|tls_failed|auth_failed|error, "detail"}."""
    host = v.hostname(host)
    port = v.port(port)
    if security not in ("starttls", "ssl", "none"):
        raise v.Invalid("invalid_value")
    factory = smtp_factory or (smtplib.SMTP_SSL if security == "ssl" else smtplib.SMTP)
    context = ssl.create_default_context()
    client = None
    try:
        if security == "ssl" and smtp_factory is None:
            client = factory(host, port, timeout=timeout, context=context)
        else:
            client = factory(host, port, timeout=timeout)
        client.ehlo()
        if security == "starttls":
            client.starttls(context=context)
            client.ehlo()
        client.login(username, password)
        return {"status": "ok", "detail": None}
    except smtplib.SMTPAuthenticationError:
        return {"status": "auth_failed", "detail": None}
    except ssl.SSLError as e:
        return {"status": "tls_failed", "detail": type(e).__name__}
    except (smtplib.SMTPNotSupportedError, smtplib.SMTPHeloError) as e:
        return {"status": "tls_failed" if security == "starttls" else "error", "detail": type(e).__name__}
    except (OSError, smtplib.SMTPConnectError, smtplib.SMTPServerDisconnected) as e:
        return {"status": "unreachable", "detail": type(e).__name__}
    except smtplib.SMTPException as e:
        return {"status": "error", "detail": type(e).__name__}
    finally:
        if client is not None:
            try:
                client.quit()
            except Exception:  # noqa: BLE001
                pass


# ─── AI 제공자 ───

# backend/app/ai/providers.py 의 DEFAULT_BASE 와 동일 주소
AI_DEFAULT_BASE = {
    "ollama": "http://host.docker.internal:11434",
    "openai": "https://api.openai.com",
    "anthropic": "https://api.anthropic.com",
    "gemini": "https://generativelanguage.googleapis.com",
    "compatible": "",
}


def ai_request(provider: str, api_key: str, base_url: str | None) -> tuple[str, dict]:
    """키 검증용 경량 호출(모델 목록) — (주소, 헤더). 키는 헤더로만 송신한다(주소에 포함하지 않는다)."""
    if provider not in AI_DEFAULT_BASE:
        raise v.Invalid("provider_unknown")
    base = (v.http_url(base_url) if base_url else AI_DEFAULT_BASE[provider]).rstrip("/")
    if not base:
        raise v.Invalid("required")
    if provider == "anthropic":
        return f"{base}/v1/models", {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
    if provider == "gemini":
        return f"{base}/v1beta/models", {"x-goog-api-key": api_key}
    if provider == "ollama":
        return f"{base}/api/tags", {}
    return f"{base}/v1/models", ({"Authorization": f"Bearer {api_key}"} if api_key else {})


def probe_ai(provider: str, api_key: str, base_url: str | None = None, *, get=None) -> dict:
    """{"status": ok|auth_failed|unreachable|error, "http_status", "models": [...]}."""
    url, headers = ai_request(provider, api_key or "", base_url)
    if get is None:
        def get(u, h):
            import httpx

            with httpx.Client(timeout=10.0) as client:
                r = client.get(u, headers=h)
            try:
                return r.status_code, r.json()
            except ValueError:
                return r.status_code, {}
    try:
        status, body = get(url, headers)
    except Exception as e:  # noqa: BLE001
        return {"status": "unreachable", "http_status": None, "models": [], "detail": type(e).__name__}
    if status in (401, 403):
        return {"status": "auth_failed", "http_status": status, "models": []}
    if status != 200:
        return {"status": "error", "http_status": status, "models": []}
    rows = (body.get("data") or body.get("models") or []) if isinstance(body, dict) else []
    models = []
    for row in rows[:200]:
        if isinstance(row, dict):
            name = row.get("id") or row.get("name")
            if isinstance(name, str):
                models.append(name.removeprefix("models/"))
    return {"status": "ok", "http_status": 200, "models": models}


# ─── 저장소 ───


def _json_tail(text: str) -> dict:
    try:
        return json.loads(text.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {}


def classify_mount_error(text: str) -> str:
    """NFS 볼륨 마운트 중 발생한 오류 문구 → 원인.

    `export_not_found`: 서버에는 도달했으나 해당 경로를 마운트할 수 없다. NFSv4 서버는 이 클라이언트에 허용하지 않은
    내보내기를 "없는 경로"로 응답하므로, 경로가 잘못된 경우와 이 서버의 주소가 허용 목록에 없는 경우가 동일한 형태로 나타난다.
    """
    low = text.lower()
    if any(k in low for k in ("permission denied", "access denied", "operation not permitted", "not permitted")):
        return "permission_denied"
    if "read-only" in low:
        return "read_only"
    if "no such file or directory" in low:
        return "export_not_found"
    return "unreachable"


def tcp_reachable(host: str, port: int, timeout: float = 5.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def probe_nfs(docker: Docker, server: str, export: str, *, volume_opts: Callable[[str, str], dict],
              reachable: Callable[[str, int], bool] = tcp_reachable) -> dict:
    """NFS 연결 확인 5단계 — 앞 단계가 실패하면 이후 단계는 생략한다.

    ① 서버 도달 여부 ② 마운트 가능 여부 ③ 쓰기·읽기·삭제(backend 가 사용하는 uid/gid 로) ④ 파일 잠금 ⑤ 여유 공간.
    임시 도커 볼륨(NFS 옵션)을 생성하여 보조 컨테이너에서 검사한 뒤 삭제한다.
    반환값: {"ok", "cause": unreachable|export_not_found|permission_denied|read_only|no_locking|null, "steps": [...]}

    볼륨은 `nocopy` 로 마운트한다. 옵션 없이 마운트하면 도커가 **빈** 볼륨의 루트를 이미지 측 폴더의 소유자·권한으로 변경하려 시도한다 —
    내보내기 루트의 소유자가 확인만으로 변경되거나(root 를 그대로 수용하는 내보내기), 해당 시도가 거부되어 마운트부터
    실패한다(root 권한을 강등하는 일반적인 내보내기). 저장소의 권한은 저장소 관리자가 지정한 상태를 유지한 채 확인한다.
    """
    server = v.hostname(server)
    export = v.nfs_export(export)
    steps = [{"id": s, "status": "skipped", "value": None} for s in ("reach", "mount", "write", "lock", "space")]
    by_id = {s["id"]: s for s in steps}

    def done(cause: str | None) -> dict:
        ok = cause is None and all(by_id[s]["status"] == "pass" for s in ("reach", "mount", "write", "lock"))
        return {"ok": ok, "cause": cause, "steps": steps}

    if not reachable(server, 2049):
        by_id["reach"]["status"] = "fail"
        return done("unreachable")
    by_id["reach"]["status"] = "pass"

    name = f"jw-nfs-probe-{secrets.token_hex(6)}"
    created = docker.volume_create(name, volume_opts(server, export), labels={"jw.temporary": "1"})
    if not created.ok:
        by_id["mount"]["status"] = "fail"
        by_id["mount"]["value"] = created.text[-300:]
        return done("unreachable")
    try:
        result = docker.helper(["nfs-test", "/mnt"], volumes=[f"{name}:/mnt:nocopy"], user=BACKEND_UID_GID, timeout=90)
        data = _json_tail(result.out) if result.ok else {}
        if not data:
            by_id["mount"]["status"] = "fail"
            by_id["mount"]["value"] = result.text[-300:]
            return done(classify_mount_error(result.text))
        by_id["mount"]["status"] = "pass"

        if data.get("write"):
            by_id["write"]["status"] = "fail"
            by_id["write"]["value"] = data["write"]
            return done("read_only" if data["write"] == "EROFS" else "permission_denied")
        by_id["write"]["status"] = "pass"
        by_id["write"]["value"] = BACKEND_UID_GID

        if data.get("lock"):
            by_id["lock"]["status"] = "fail"
            by_id["lock"]["value"] = data["lock"]
            return done("no_locking")
        by_id["lock"]["status"] = "pass"

        free = data.get("free_bytes")
        if isinstance(free, int):
            by_id["space"]["value"] = round(free / GB, 1)
            by_id["space"]["status"] = "warn" if free < NFS_FREE_WARN_GB * GB else "pass"
        else:
            by_id["space"]["status"] = "warn"
        return done(None)
    finally:
        docker.volume_rm(name)


def probe_local_path(docker: Docker, path: str) -> dict:
    """호스트에 이미 존재하는 폴더인지, backend 가 기록할 수 있는지 확인.

    {"status": ok|not_found|not_writable|error, "free_gb"}. `--mount type=bind` 는 원본 경로가 없으면 실패한다
    (`-v` 는 없는 폴더를 생성한다).
    """
    path = v.host_path(path)
    result = docker.helper(["path-test", "/probe"], mounts=[f"type=bind,source={path},target=/probe"],
                           user=BACKEND_UID_GID, timeout=60)
    if not result.ok:
        low = result.text.lower()
        if "does not exist" in low or "no such file" in low:
            return {"status": "not_found", "path": path}
        return {"status": "error", "path": path, "detail": result.text[-300:]}
    data = _json_tail(result.out)
    if not data.get("exists", False):
        return {"status": "not_found", "path": path}
    free = data.get("free_bytes")
    out = {"path": path, "free_gb": round(free / GB, 1) if isinstance(free, int) else None}
    if not data.get("writable"):
        return {"status": "not_writable", "error": data.get("error"), "uid_gid": BACKEND_UID_GID, **out}
    return {"status": "ok", **out}
