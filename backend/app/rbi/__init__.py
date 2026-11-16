"""격리 브라우저(RBI, Remote Browser Isolation) 모듈.

취약한 내부 웹 자산(예: 패치 불가 PHP 앱)을 인터넷에서 분리하고, 외부 사용자는 LAN 내에서 세션마다
새로 기동하는 일회용 브라우저 컨테이너(KasmVNC)의 화면만 수신한다. 구조·보안 모델·운영은 docs/rbi.md.
"""
