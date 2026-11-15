<!-- English is welcome. 기여 안내: CONTRIBUTING.md -->

## 무엇을 왜 바꿨나

<!-- 관련 이슈가 있으면 적어 주세요(예: Fixes #123). -->

## 어떻게 확인했나

<!-- 돌려 본 것과 돌려 보지 못한 것을 구분해 적어 주세요. -->

- [ ] backend 테스트 (`cd backend && python -m pytest -q`)
- [ ] 프런트 (`npm run typecheck` · `npm run lint` · `npm test`)
- [ ] 설치 관리자 테스트 (`cd installer && python -m pytest -q`)
- [ ] 릴리스 도구 테스트 (`cd release && python -m pytest`)
- [ ] 실제로 띄워서 확인 — 어떻게:
- [ ] 해당 없음(문서만 등)

## 함께 고쳤나

- [ ] 동작이 바뀌면 문서(`docs/`)와 화면 문구(한국어·영어)
- [ ] 환경변수를 더하거나 뺐다면 `.env.example` 과 `docs/CONFIG.md`
- [ ] DB 구조를 바꿨다면 번호 붙은 변경 단계(`docs/data-safety.md`)
- [ ] 의존성을 더했다면 `THIRD_PARTY_LICENSES.md` (GPL·LGPL·MPL 계열은 아래에 따로 적기 — 오픈소스가 아닌 것은 받지 않습니다)
- [ ] 비밀값, 실제 주소·도메인·이름이 들어가지 않았다

## 더 알려 줄 것

<!-- 검토할 때 봐 줬으면 하는 곳, 알려진 한계, 뒤에 남는 일 -->
