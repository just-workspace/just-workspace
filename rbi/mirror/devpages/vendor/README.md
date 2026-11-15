# devpages/vendor — 시험용 제3자 파일(개발 이미지 `dev` 대상에만 들어간다, 운영 이미지 `prod` 에는 없다)

격리 브라우저 미러 모드([docs/rbi.md](../../../../docs/rbi.md) 6절)의 시험 페이지(`rbi/mirror/devpages/`)에서 쓰려고 넣은 라이브러리다.
오래된 웹 관리 화면이 흔히 쓰는 것들(jsPlumb·Bootstrap 3·Font Awesome 4)이라, 그런 화면의 DOM 모양·아이콘 폰트·jsPlumb SVG 를 재현해 미러가 제대로 그리는지 보는 용도다.
직접 고치지 않은 배포본 그대로다. 지금 `devpages/` 의 시험 페이지 가운데 이 파일들을 불러오는 것은 없다.

| 파일 | 출처 | 버전 | 라이선스 |
|---|---|---|---|
| js/jsplumb.min.js | npm jsplumb | 2.15.6 | MIT 또는 GPL-2.0(이중) — MIT 로 사용 |
| css/bootstrap.min.css · fonts/glyphicons-halflings-regular.woff2 | npm bootstrap | 3.4.1 | MIT |
| css/font-awesome.min.css · fonts/fontawesome-webfont.woff2 | npm font-awesome | 4.7.0 | CSS MIT · 폰트 OFL-1.1 |
