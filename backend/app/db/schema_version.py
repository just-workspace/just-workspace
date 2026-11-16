"""코드가 요구하는 DB 스키마 버전 — 단일 출처.

- `SCHEMA_VERSION`: 본 코드의 실행에는 DB 가 정확히 이 버전이어야 한다. 낮으면 변경 단계를 적용하고,
  높으면(이미지를 롤백했으나 DB 는 신규 버전) 서버가 기동하지 않는다.
- `BASELINE_VERSION`: 버전 기록 도입 이전의 스키마 전체(app/db/baseline.py).
- `MODELS_FINGERPRINT`: 모델(테이블·컬럼·타입)의 지문. 모델 수정 후 변경 단계를 누락하는 오류를
  tests/test_schema_migrate.py 가 이 값으로 검출한다. 현재 값은 `python -m app.cli schema-version --fingerprint`.

스키마 변경 절차는 docs/data-safety.md 의 "변경 단계 작성법"에 기술되어 있다.
본 모듈은 어떤 것도 import 하지 않는다(릴리스 도구가 DB 없이 읽는다).
"""

BASELINE_VERSION = 1
SCHEMA_VERSION = 2

MODELS_FINGERPRINT = "eccc3bf7d7937683"
