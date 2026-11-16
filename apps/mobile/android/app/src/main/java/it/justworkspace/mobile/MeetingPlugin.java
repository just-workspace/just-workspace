package it.justworkspace.mobile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 웹(useNativeMeeting.ts)이 호출하는 회의 플러그인.
 *   start({ title, video })  회의 입장 직후
 *   stop()                   회의 퇴장 시
 * 이벤트 "meeting": { type: hold|unhold|disconnect|leave|audioRoute|telecomFailed|serviceFailed, detail }
 */
@CapacitorPlugin(name = "Meeting")
public class MeetingPlugin extends Plugin {

    @Override
    public void load() {
        MeetingCall.setListener((type, detail) -> {
            JSObject ev = new JSObject();
            ev.put("type", type);
            ev.put("detail", detail);
            notifyListeners("meeting", ev, true);
        });
    }

    @PluginMethod
    public void start(PluginCall call) {
        String title = call.getString("title", "회의");
        boolean video = Boolean.TRUE.equals(call.getBoolean("video", false));
        MeetingCall.title = title;
        MeetingService.start(getContext(), title, video);
        // 이미 OS 통화로 등록되어 있으면(재입장) 다시 발신하지 않는다
        boolean telecom = MeetingCall.getConnection() != null || MeetingCall.placeCall(getContext(), title);
        JSObject ret = new JSObject();
        ret.put("telecom", telecom);
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        MeetingCall.endCall();
        MeetingService.stop(getContext());
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        MeetingCall.setListener(null);
    }
}
