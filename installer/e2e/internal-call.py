"""내부 API(8444)를 부른다 — backend 컨테이너 안에서 돈다(backend 가 부르는 방식 그대로).

주소와 키는 backend 가 받은 환경변수(JW_INSTALLER_URL, JW_INSTALLER_KEY)를 쓴다.
    E2E_METHOD  E2E_PATH  [E2E_BODY]  [E2E_KEY — 키를 바꿔 볼 때]  [E2E_URL — 주소를 바꿔 볼 때]
출력: "<상태 코드> <본문>"
"""
import os
import urllib.error
import urllib.request

url = (os.environ.get("E2E_URL") or os.environ["JW_INSTALLER_URL"]).rstrip("/") + os.environ["E2E_PATH"]
body = os.environ.get("E2E_BODY") or None
key = os.environ.get("E2E_KEY") or os.environ.get("JW_INSTALLER_KEY", "")
req = urllib.request.Request(url, method=os.environ.get("E2E_METHOD", "GET"), data=body.encode() if body else None,
                             headers={"X-JW-Installer-Key": key, "Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print(r.status, r.read().decode())
except urllib.error.HTTPError as e:
    print(e.code, e.read().decode())
except Exception as e:  # noqa: BLE001
    print(0, type(e).__name__)
