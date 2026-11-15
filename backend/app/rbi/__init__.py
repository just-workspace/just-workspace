"""격리 브라우저(RBI, Remote Browser Isolation) 모듈.

취약한 내부 웹 자산(예: 패치 불가 PHP 앱)을 인터넷에서 떼어 내고, 바깥 사용자는 LAN 안에서 세션마다
새로 띄우는 일회용 브라우저 컨테이너(KasmVNC)의 화면만 받는다. 구조·보안 모델·운영은 docs/rbi.md.
"""
