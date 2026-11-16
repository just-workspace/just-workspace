"""Just Workspace 릴리스 도구 — 채널·릴리스 목록의 형식, 서명·검증, 생성 명령.

설치 관리자가 사용하는 부분은 `semver`, `model`, `verify` 세 모듈이다(의존성: `cryptography`).
나머지(`compose`, `builder`, `channelrepo`, `bundle`, `sign`, `registry`, `cli`)는 릴리스 게시 측 전용이다.
"""

FORMAT = 1
