"""샌드박스 보조 — 슬롯 uid 로 돈다(서버가 사용자 코드가 만든 파일을 직접 따라가지 않게).

  collect <output_dir> <max_files> <max_bytes>   → stdout 에 {"files":[{name,data,size}], "skipped":[...]}
  clean <work_dir>                               → 작업 디렉터리 내용 삭제(권한을 되살려 가며)
"""

import base64
import json
import os
import shutil
import stat
import sys


def collect(out_dir: str, max_files: int, max_bytes: int) -> None:
    files, skipped, total = [], [], 0
    base = os.path.realpath(out_dir)
    for dirpath, dirnames, filenames in os.walk(out_dir, followlinks=False):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for n in sorted(filenames):
            if n.startswith("."):
                continue
            p = os.path.join(dirpath, n)
            rel = os.path.relpath(p, out_dir).replace(os.sep, "/")
            try:
                st = os.lstat(p)
            except OSError:
                continue
            if not stat.S_ISREG(st.st_mode):
                skipped.append(f"{rel}: 일반 파일이 아님")
                continue
            if not os.path.realpath(p).startswith(base + os.sep):
                skipped.append(f"{rel}: 출력 폴더 밖")
                continue
            if len(files) >= max_files:
                skipped.append(f"{rel}: 파일 수 상한({max_files}) 초과")
                continue
            if total + st.st_size > max_bytes:
                skipped.append(f"{rel}: 총 크기 상한 초과")
                continue
            try:
                fd = os.open(p, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                with os.fdopen(fd, "rb") as f:
                    data = f.read(max_bytes - total + 1)
            except OSError as e:
                skipped.append(f"{rel}: 읽기 실패({e.__class__.__name__})")
                continue
            total += len(data)
            files.append({"name": rel, "data": base64.b64encode(data).decode("ascii"), "size": len(data)})
    sys.stdout.write(json.dumps({"files": files, "skipped": skipped}, ensure_ascii=False))


def clean(work: str) -> None:
    for dirpath, dirnames, _ in os.walk(work):
        for d in dirnames:
            try:
                os.chmod(os.path.join(dirpath, d), 0o700, follow_symlinks=False)
            except (OSError, NotImplementedError):
                pass
    for n in os.listdir(work):
        p = os.path.join(work, n)
        try:
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p, ignore_errors=True)
            else:
                os.unlink(p)
        except OSError:
            pass


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "collect":
        collect(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
    elif cmd == "clean":
        clean(sys.argv[2])
    else:
        sys.exit(2)
