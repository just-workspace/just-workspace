"""코드가 요구하는 DB 스키마 버전 — 단일 출처.

- `SCHEMA_VERSION`: 이 코드가 돌려면 DB 가 정확히 이 버전이어야 한다. 낮으면 변경 단계를 적용하고,
  높으면(이미지를 되돌렸는데 DB 는 새것) 서버가 뜨지 않는다.
- `BASELINE_VERSION`: 버전 기록이 생기기 전의 스키마 전체(app/db/baseline.py).
- `MODELS_FINGERPRINT`: 모델(테이블·컬럼·타입)의 지문. 모델을 고치고 변경 단계를 빠뜨리는 실수를
  tests/test_schema_migrate.py 가 이 값으로 잡는다. 지금 값은 `python -m app.cli schema-version --fingerprint`.

스키마를 바꿀 때 하는 일은 docs/data-safety.md 의 "변경 단계 작성법"에 있다.
이 모듈은 아무것도 import 하지 않는다(릴리스 도구가 DB 없이 읽는다).
"""

BASELINE_VERSION = 1
SCHEMA_VERSION = 1

MODELS_FINGERPRINT = "e3a36000e8b9a9e2"
