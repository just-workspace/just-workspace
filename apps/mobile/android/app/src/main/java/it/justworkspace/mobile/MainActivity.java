package it.justworkspace.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 앱 안 플러그인은 super.onCreate(브리지 생성) 전에 등록해야 한다
        registerPlugin(MeetingPlugin.class);
        registerPlugin(WebUiPlugin.class);
        // 본문 웹 UI(Vue/React) 쿠키 — 브리지가 server.url 을 열기 전에 심는다(WebUiPlugin 주석).
        // 번들 빌드(server.url 없음)는 앱 안에 React 가 들어 있어 필요 없다.
        try {
            CapConfig cfg = CapConfig.loadDefault(this);
            WebUiPlugin.apply(cfg.getServerUrl(), cfg.getPluginConfiguration("WebUi").getString("web", "vue"));
        } catch (Exception ignored) {
            // 실패해도 앱은 뜬다 — 서버 기본 UI 가 나올 뿐이다
        }
        super.onCreate(savedInstanceState);
    }
}
