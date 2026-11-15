package it.justworkspace.mobile;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 앱 안 플러그인은 super.onCreate(브리지 생성) 전에 등록해야 한다
        registerPlugin(MeetingPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
