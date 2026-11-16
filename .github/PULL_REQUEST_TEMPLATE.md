<!-- Pull requests may be submitted in English. 기여 규정: CONTRIBUTING.md -->

## 변경 내용 및 사유

<!-- 관련 이슈가 있는 경우 기재한다(예: Fixes #123). -->

## 검증 방법

<!-- 실행하여 검증한 항목과 검증하지 못한 항목을 구분하여 기재한다. -->

- [ ] backend 테스트 (`cd backend && python -m pytest -q`)
- [ ] 프런트 (`npm run typecheck` · `npm run lint` · `npm test`)
- [ ] 설치 관리자 테스트 (`cd installer && python -m pytest -q`)
- [ ] 릴리스 도구 테스트 (`cd release && python -m pytest`)
- [ ] 실제 기동 후 검증 — 방법:
- [ ] 해당 없음(문서 한정 등)

## 동반 수정 사항

- [ ] 동작 변경 시 문서(`docs/`)와 화면 문구(한국어·영어)
- [ ] 환경변수 추가·삭제 시 `.env.example` 과 `docs/CONFIG.md`
- [ ] DB 구조 변경 시 번호가 부여된 변경 단계(`docs/data-safety.md`)
- [ ] 의존성 추가 시 `THIRD_PARTY_LICENSES.md` (GPL·LGPL·MPL 계열은 아래에 별도 명시 — 비오픈소스 의존성은 접수하지 않는다)
- [ ] 비밀값 및 실제 주소·도메인·이름을 포함하지 않았음

## 기여 조건

- [ ] 기여 조건(CONTRIBUTING.md)을 확인하였으며 이에 동의함 / I have read and agree to the contribution terms in CONTRIBUTING.md.

## 추가 정보

<!-- 검토 시 확인이 필요한 부분, 알려진 제한 사항, 후속 작업 -->
