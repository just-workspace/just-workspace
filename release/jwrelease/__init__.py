"""Just Workspace 릴리스 도구 — 채널·릴리스 목록의 형식, 서명·검증, 만드는 명령.

설치 관리자가 가져다 쓰는 부분은 `semver`, `model`, `verify` 셋이다(의존성: `cryptography`).
나머지(`compose`, `builder`, `channelrepo`, `bundle`, `sign`, `registry`, `cli`)는 릴리스를 내는 쪽 전용.
"""

FORMAT = 1
