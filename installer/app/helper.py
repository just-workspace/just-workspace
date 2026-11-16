"""보조 컨테이너 안에서 도는 작은 명령들 — `python -m app.helper <명령> …`.

설치 관리자는 자기 이미지로 일회용 컨테이너를 띄워, 자기 컨테이너에서는 볼 수 없는 것을 본다
(호스트 네트워크의 포트·경로, 도커 볼륨 안, NFS 볼륨). 표준 라이브러리만 쓴다.
결과는 표준 출력에 JSON 한 덩어리. 종료 코드 0 = 명령이 돌았다(판정은 JSON 안에), 그 밖 = 명령 자체가 실패.

| 명령 | 띄우는 방법 | 하는 일 |
|---|---|---|
| `host-probe --ports 80,443,25` | `--network host` | 포트 점유(bind 시도), 호스트 경로표, 나가는 주소, 기본 게이트웨이 |
| `disk <경로>` | 볼륨/폴더를 붙여서 | 여유 공간 |
| `path-test <경로>` | `--mount type=bind`, uid 1000 | 쓰기·읽기·지우기 |
| `nfs-test <경로>` | NFS 볼륨, uid 1000 | 쓰기·읽기·지우기, 파일 잠금, 여유 공간 |
| `write-marker <경로> --install-id <id>` | 저장소 볼륨, uid 1000 | 표식 파일 쓰기 |
| `read-marker <경로>` | 저장소 볼륨 | 표식 파일 읽기(복원 — 같은 설치의 저장소인지) |
| `restore-files <백업> <경로> --member <이름>` | 백업(읽기 전용) + 저장소 볼륨, root 로 시작 | 백업 안의 파일 묶음을 저장소에 푼다 |
| `place-cert …` · `read-cert …` | 인증서 볼륨 | 인증서 배치·읽기 |
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import socket
import struct
import sys
import time

MARKER_NAME = ".jw-storage"
LE_ROOT = "/etc/letsencrypt"
RELAY_GID = 65532          # 무손실 음성 릴레이 컨테이너의 gid — 개인 키를 그룹 읽기로 열어 준다


def _out(data: dict) -> int:
    print(json.dumps(data, ensure_ascii=False))
    return 0


# ─── host-probe ───


def port_state(port: int) -> str:
    """그 TCP 포트를 지금 누가 듣고 있는가 — 직접 bind 해 본다."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("0.0.0.0", port))
        return "free"
    except OSError as e:
        if e.errno == errno.EADDRINUSE:
            return "used"
        return "error"
    finally:
        s.close()


def parse_routes(text: str) -> list[dict]:
    """/proc/net/route → [{"dest": "192.168.10.0/24", "iface": "eth0"}] (기본 경로 제외)."""
    routes = []
    for line in text.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 8:
            continue
        iface, dest_hex, mask_hex = parts[0], parts[1], parts[7]
        try:
            dest = socket.inet_ntoa(struct.pack("<L", int(dest_hex, 16)))
            mask = struct.unpack("<L", struct.pack("<L", int(mask_hex, 16)))[0]
            prefix = bin(socket.ntohl(mask) & 0xFFFFFFFF).count("1")
        except (ValueError, struct.error):
            continue
        if prefix == 0:
            continue
        routes.append({"dest": f"{dest}/{prefix}", "iface": iface})
    return routes


def parse_default_gateway(text: str) -> str:
    """/proc/net/route → 기본 경로의 게이트웨이 주소(없으면 빈 문자열). 여럿이면 metric 이 가장 낮은 것."""
    best: tuple[int, str] | None = None
    for line in text.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 8:
            continue
        try:
            dest, gateway, flags, metric, mask = (int(parts[1], 16), int(parts[2], 16), int(parts[3], 16),
                                                  int(parts[6]), int(parts[7], 16))
        except ValueError:
            continue
        if dest != 0 or mask != 0 or not flags & 0x2 or not gateway:   # 0x2 = RTF_GATEWAY
            continue
        address = socket.inet_ntoa(struct.pack("<L", gateway))
        if best is None or metric < best[0]:
            best = (metric, address)
    return best[1] if best else ""


def outbound_address() -> str:
    """밖으로 나갈 때 쓰는 호스트 주소(패킷은 보내지 않는다)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("203.0.113.1", 9))
        return s.getsockname()[0]
    except OSError:
        return ""
    finally:
        s.close()


def cmd_host_probe(args) -> int:
    ports = {str(p): port_state(int(p)) for p in args.ports.split(",") if p.strip()}
    try:
        with open("/proc/net/route", encoding="ascii") as f:
            table = f.read()
    except OSError:
        table = ""
    routes = parse_routes(table)
    selinux = ""
    try:
        with open("/sys/fs/selinux/enforce", encoding="ascii") as f:
            selinux = "enforcing" if f.read().strip() == "1" else "permissive"
    except OSError:
        pass
    return _out({"ports": ports, "routes": routes, "outbound_address": outbound_address(),
                 "gateway": parse_default_gateway(table), "selinux": selinux})


# ─── disk / path / nfs ───


def _uid() -> int:
    return os.getuid() if hasattr(os, "getuid") else 0


def free_bytes(path: str) -> int:
    import shutil

    return shutil.disk_usage(path).free


def cmd_disk(args) -> int:
    try:
        return _out({"free_bytes": free_bytes(args.path)})
    except OSError as e:
        return _out({"error": errno.errorcode.get(e.errno, "EIO")})


def _write_read_delete(folder: str) -> str | None:
    """쓰기·읽기·지우기. 성공하면 None, 아니면 errno 이름."""
    name = os.path.join(folder, f".jw-probe-{os.getpid()}-{int(time.time())}")
    payload = b"just-workspace storage probe\n"
    try:
        with open(name, "wb") as f:
            f.write(payload)
            f.flush()
            os.fsync(f.fileno())
        with open(name, "rb") as f:
            if f.read() != payload:
                return "EIO"
        os.unlink(name)
        return None
    except OSError as e:
        try:
            os.unlink(name)
        except OSError:
            pass
        return errno.errorcode.get(e.errno, "EIO")


def _lock_test(folder: str) -> str | None:
    import fcntl

    name = os.path.join(folder, f".jw-lock-{os.getpid()}-{int(time.time())}")
    try:
        with open(name, "wb") as f:
            fcntl.lockf(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.lockf(f, fcntl.LOCK_UN)
        os.unlink(name)
        return None
    except OSError as e:
        try:
            os.unlink(name)
        except OSError:
            pass
        return errno.errorcode.get(e.errno, "EIO")


def cmd_path_test(args) -> int:
    if not os.path.isdir(args.path):
        return _out({"exists": False})
    err = _write_read_delete(args.path)
    out = {"exists": True, "writable": err is None, "error": err, "uid": _uid()}
    try:
        out["free_bytes"] = free_bytes(args.path)
    except OSError:
        pass
    return _out(out)


def cmd_nfs_test(args) -> int:
    write_err = _write_read_delete(args.path)
    out: dict = {"write": write_err, "lock": None, "uid": _uid()}
    if write_err is None:
        out["lock"] = _lock_test(args.path)
    try:
        out["free_bytes"] = free_bytes(args.path)
    except OSError:
        out["free_bytes"] = None
    return _out(out)


# ─── 저장소 표식 ───


def cmd_write_marker(args) -> int:
    path = os.path.join(args.path, MARKER_NAME)
    try:
        with open(path, encoding="utf-8") as f:
            existing = json.load(f)
    except FileNotFoundError:
        existing = None
    except (OSError, ValueError):
        existing = {}
    if existing is not None:
        found = str(existing.get("install_id", ""))
        if found == args.install_id:
            return _out({"status": "exists"})
        if not args.adopt:
            return _out({"status": "other_install", "install_id": found})
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"install_id": args.install_id, "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                       "note": "Just Workspace 파일 저장소 표식 - 지우지 마세요. 이 파일이 안 보이면 파일 저장이 막힙니다."},
                      f, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    except OSError as e:
        return _out({"status": "error", "error": errno.errorcode.get(e.errno, "EIO")})
    return _out({"status": "written"})


def cmd_read_marker(args) -> int:
    """{"status": found|missing|unreadable, "install_id"} — 아무것도 쓰지 않는다."""
    path = os.path.join(args.path, MARKER_NAME)
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        return _out({"status": "missing", "install_id": None})
    except (OSError, ValueError):
        return _out({"status": "unreadable", "install_id": None})
    return _out({"status": "found", "install_id": str((data or {}).get("install_id", "")) if isinstance(data, dict) else ""})


# ─── 복원: 파일 저장소 되돌리기 ───
#
# 백업은 폴더이거나 tar 한 개(.jwbak)이고, 파일 저장소는 그 안의 tar(압축 없음) 한 멤버다.
# 백업 파일은 소유자(root)만 읽을 수 있고 저장소는 backend 의 사용자(uid 1000)가 써야 한다 —
# root 로 백업을 연 뒤 **권한을 내리고** 푼다(root 를 낮추는 NFS 내보내기에서도 쓸 수 있고, 파일 소유자가 backend 가 된다).


def _open_member(source: str, member: str):
    """(읽을 파일 객체, 닫을 것들). 백업이 폴더면 그 안의 파일, tar 면 그 멤버."""
    import tarfile

    if os.path.isdir(source):
        f = open(os.path.join(source, member), "rb")
        return f, [f]
    outer = tarfile.open(source, mode="r:")
    for info in outer:
        if info.name == member and info.isfile():
            return outer.extractfile(info), [outer]
    outer.close()
    raise FileNotFoundError(member)


def _wipe(folder: str) -> None:
    import shutil

    for entry in os.listdir(folder):
        path = os.path.join(folder, entry)
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path)
        else:
            os.unlink(path)


def cmd_restore_files(args) -> int:
    import tarfile

    if os.sep in args.member or args.member.startswith("."):
        return _out({"status": "error", "error": "bad_member"})
    try:
        stream, closers = _open_member(args.source, args.member)
    except (OSError, tarfile.TarError) as e:
        return _out({"status": "error", "error": "source_unreadable", "detail": str(e)[:200]})
    try:
        if _uid() == 0 and args.uid:
            os.setgroups([])
            os.setgid(args.gid)
            os.setuid(args.uid)
        _wipe(args.path)
        count = total = 0
        with tarfile.open(fileobj=stream, mode="r|") as inner:
            for info in inner:
                inner.extract(info, args.path, filter="data")
                count += 1
                total += info.size if info.isfile() else 0
    except (OSError, tarfile.TarError) as e:
        code = errno.errorcode.get(getattr(e, "errno", None) or 0, "") if isinstance(e, OSError) else ""
        return _out({"status": "error", "error": code or type(e).__name__, "detail": str(e)[:200]})
    finally:
        for c in closers:
            try:
                c.close()
            except OSError:
                pass
    return _out({"status": "restored", "entries": count, "bytes": total})


# ─── 인증서 배치 ───
#
# 인증서 볼륨(/etc/letsencrypt)의 배치:
#   live/<접속 주소>/          nginx · 무손실 음성 릴레이가 읽는다
#     · 자동 발급: certbot 이 만든 폴더(진짜 파일은 archive/ 에 있다)
#     · 올린 파일·임시 인증서: jw/<접속 주소>/ 를 가리키는 링크
#   live/mail.<메일 도메인>   → <접속 주소>    메일 서버가 찾는 자리
#   live/turn.<접속 주소>     → <접속 주소>    회의 서버(TURN/TLS)가 찾는 자리
# 링크는 모두 상대 경로라 어느 컨테이너에 붙여도 같은 파일을 가리킨다.


def _safe_name(name: str) -> str:
    if not name or name.startswith(".") or "/" in name or "\\" in name or ".." in name:
        raise SystemExit(f"bad name: {name!r}")
    return name


def _open_for_relay(path: str, mode: int) -> None:
    try:
        os.chown(path, -1, RELAY_GID)
        os.chmod(path, mode)
    except OSError:
        pass


def cmd_place_cert(args) -> int:
    root = args.root
    name = _safe_name(args.name)
    live = os.path.join(root, "live")
    os.makedirs(live, exist_ok=True)
    target = os.path.join(live, name)

    if not args.link_only:
        data = json.load(sys.stdin)
        store = os.path.join(root, "jw", name)
        os.makedirs(store, exist_ok=True)
        for filename, content, mode in (("fullchain.pem", data["cert"], 0o644), ("privkey.pem", data["key"], 0o640)):
            tmp = os.path.join(store, filename + ".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(content)
            os.chmod(tmp, mode)
            os.replace(tmp, os.path.join(store, filename))
        if os.path.islink(target):
            os.unlink(target)
        elif os.path.isdir(target):
            # certbot 이 관리하는 폴더가 이미 있다 — 덮지 않는다(자동 발급으로 받은 인증서를 지우게 된다)
            return _out({"status": "managed_by_certbot"})
        os.symlink(os.path.join("..", "jw", name), target)
        for path, mode in ((os.path.join(root, "jw"), 0o750), (store, 0o750),
                           (os.path.join(store, "privkey.pem"), 0o640)):
            _open_for_relay(path, mode)
    elif not os.path.isdir(target):
        return _out({"status": "missing"})
    else:
        archive = os.path.join(root, "archive")
        for path, mode in ((archive, 0o750), (os.path.join(archive, name), 0o750)):
            if os.path.isdir(path):
                _open_for_relay(path, mode)
        folder = os.path.join(archive, name)
        if os.path.isdir(folder):
            for entry in os.listdir(folder):
                if entry.startswith("privkey"):
                    _open_for_relay(os.path.join(folder, entry), 0o640)
    _open_for_relay(live, 0o750)

    linked, skipped = [], []
    for alias in [a for a in (args.aliases or "").split(",") if a]:
        alias = _safe_name(alias)
        if alias == name:
            continue
        path = os.path.join(live, alias)
        if os.path.islink(path):
            os.unlink(path)
        elif os.path.exists(path):
            skipped.append(alias)
            continue
        os.symlink(name, path)
        linked.append(alias)
    return _out({"status": "placed", "linked": linked, "skipped": skipped})


def cmd_read_cert(args) -> int:
    path = os.path.join(args.root, "live", _safe_name(args.name), "fullchain.pem")
    try:
        with open(path, encoding="utf-8") as f:
            return _out({"cert": f.read()})
    except OSError:
        return _out({"cert": None})


def cmd_unlink_cert(args) -> int:
    """올린 파일·임시 인증서를 가리키던 링크를 뗀다(자동 발급으로 바꿀 때). certbot 폴더는 건드리지 않는다."""
    path = os.path.join(args.root, "live", _safe_name(args.name))
    if os.path.islink(path):
        os.unlink(path)
        return _out({"status": "unlinked"})
    return _out({"status": "kept"})


def cmd_drop_cert(args) -> int:
    """그 이름의 인증서를 통째로 치운다(링크·certbot 폴더·갱신 설정). 복원에서, 되돌린 인증서를 쓰지 않게 됐을 때만 부른다."""
    import shutil

    name = _safe_name(args.name)
    removed = []
    for path in (os.path.join(args.root, "live", name), os.path.join(args.root, "archive", name),
                 os.path.join(args.root, "jw", name), os.path.join(args.root, "renewal", name + ".conf")):
        try:
            if os.path.islink(path) or os.path.isfile(path):
                os.unlink(path)
            elif os.path.isdir(path):
                shutil.rmtree(path)
            else:
                continue
            removed.append(os.path.relpath(path, args.root))
        except OSError:
            pass
    return _out({"status": "dropped", "removed": removed})


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="app.helper")
    sub = p.add_subparsers(dest="command", required=True)
    s = sub.add_parser("host-probe"); s.add_argument("--ports", default="80,443,25"); s.set_defaults(func=cmd_host_probe)
    s = sub.add_parser("disk"); s.add_argument("path"); s.set_defaults(func=cmd_disk)
    s = sub.add_parser("path-test"); s.add_argument("path"); s.set_defaults(func=cmd_path_test)
    s = sub.add_parser("nfs-test"); s.add_argument("path"); s.set_defaults(func=cmd_nfs_test)
    s = sub.add_parser("write-marker"); s.add_argument("path"); s.add_argument("--install-id", required=True)
    s.add_argument("--adopt", action="store_true"); s.set_defaults(func=cmd_write_marker)
    s = sub.add_parser("read-marker"); s.add_argument("path"); s.set_defaults(func=cmd_read_marker)
    s = sub.add_parser("restore-files"); s.add_argument("source"); s.add_argument("path")
    s.add_argument("--member", required=True); s.add_argument("--uid", type=int, default=1000)
    s.add_argument("--gid", type=int, default=1000); s.set_defaults(func=cmd_restore_files)
    s = sub.add_parser("place-cert"); s.add_argument("--root", default=LE_ROOT); s.add_argument("--name", required=True)
    s.add_argument("--aliases", default=""); s.add_argument("--link-only", action="store_true")
    s.set_defaults(func=cmd_place_cert)
    s = sub.add_parser("unlink-cert"); s.add_argument("--root", default=LE_ROOT); s.add_argument("--name", required=True)
    s.set_defaults(func=cmd_unlink_cert)
    s = sub.add_parser("read-cert"); s.add_argument("--root", default=LE_ROOT); s.add_argument("--name", required=True)
    s.set_defaults(func=cmd_read_cert)
    s = sub.add_parser("drop-cert"); s.add_argument("--root", default=LE_ROOT); s.add_argument("--name", required=True)
    s.set_defaults(func=cmd_drop_cert)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
