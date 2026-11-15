package it.justworkspace.mobile;

import android.net.Uri;
import android.webkit.CookieManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 본문 웹 UI 고르기 — Vue(frontend) / React(frontend-react).
 *
 * 앱은 서버의 웹을 그대로 연다(capacitor.config server.url). 서버 nginx 는 쿠키 jw_ui 로 어느 UI 를
 * 내줄지 정하므로(nginx.conf /__ui/react·/__ui/vue), 첫 로드 전에 그 쿠키를 웹뷰에 심는다.
 * 값은 빌드 때 capacitor.config.json 의 plugins.WebUi.web 에 구워진다(scripts/bake-site.cjs, JW_WEB).
 *
 *  - 사이트 빌드: MainActivity 가 브리지 생성 전에 server.url 에 대해 apply() 를 부른다.
 *  - URL 입력형(런처 www/index.html): 주소를 고른 뒤 이동하기 전에 WebUi.apply({ url }) 를 부른다.
 *
 * vue 도 지우지 않고 jw_ui=vue 로 명시한다 — 서버 기본값이 React 가 돼도 vue 빌드는 Vue 에 남는다.
 * Capacitor 의 HTML 프록시(WebViewLocalServer.handleProxyRequest)는 CookieManager 의 쿠키를 그대로 실어
 * 보내므로 문서·자산 요청 모두 같은 UI 를 받는다.
 */
@CapacitorPlugin(name = "WebUi")
public class WebUiPlugin extends Plugin {

    static final String COOKIE = "jw_ui";

    /** 'react' 만 react, 나머지는 vue(운영 기본값 쪽으로 넘어진다) */
    static String normalize(String web) {
        return "react".equalsIgnoreCase(web == null ? "" : web.trim()) ? "react" : "vue";
    }

    /** url 의 출처에 jw_ui 쿠키를 심는다. http(s) 가 아니면 아무것도 안 한다. */
    static void apply(String url, String web) {
        if (url == null) return;
        Uri u = Uri.parse(url);
        String scheme = u.getScheme();
        if (u.getHost() == null || !("https".equals(scheme) || "http".equals(scheme))) return;
        String origin = scheme + "://" + u.getEncodedAuthority();
        CookieManager cm = CookieManager.getInstance();
        cm.setCookie(origin, COOKIE + "=" + normalize(web) + "; Path=/; Max-Age=31536000; SameSite=Lax");
        cm.flush();
    }

    @PluginMethod
    public void apply(PluginCall call) {
        String url = call.getString("url");
        String web = normalize(getConfig().getString("web", "vue"));
        apply(url, web);
        JSObject ret = new JSObject();
        ret.put("web", web);
        call.resolve(ret);
    }
}
