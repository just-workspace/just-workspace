package it.justworkspace.mobile;

import android.os.Build;
import android.telecom.CallAudioState;
import android.telecom.Connection;
import android.telecom.ConnectionRequest;
import android.telecom.ConnectionService;
import android.telecom.DisconnectCause;
import android.telecom.PhoneAccountHandle;

import androidx.annotation.RequiresApi;

/**
 * 회의를 Telecom 의 self-managed 통화로 보이게 하는 서비스.
 * 일반 전화가 오면 OS 가 onHold 를 부르고, 전화가 끝나면 onUnhold 를 부른다.
 * 블루투스 헤드셋의 통화 종료 버튼은 onDisconnect 로 온다.
 */
@RequiresApi(api = Build.VERSION_CODES.O)
public class MeetingConnectionService extends ConnectionService {

    @Override
    public Connection onCreateOutgoingConnection(PhoneAccountHandle account, ConnectionRequest request) {
        MeetingConnection c = new MeetingConnection();
        c.setAddress(request.getAddress(), android.telecom.TelecomManager.PRESENTATION_ALLOWED);
        c.setCallerDisplayName(MeetingCall.title, android.telecom.TelecomManager.PRESENTATION_ALLOWED);
        c.setActive();
        MeetingCall.setConnection(c);
        return c;
    }

    @Override
    public void onCreateOutgoingConnectionFailed(PhoneAccountHandle account, ConnectionRequest request) {
        // 회의는 포그라운드 서비스만으로 계속된다. 웹에는 알리기만 한다.
        MeetingCall.emit("telecomFailed", "");
    }

    static final class MeetingConnection extends Connection {
        MeetingConnection() {
            setConnectionProperties(PROPERTY_SELF_MANAGED);
            setConnectionCapabilities(CAPABILITY_HOLD | CAPABILITY_SUPPORT_HOLD | CAPABILITY_MUTE);
            setAudioModeIsVoip(true);
        }

        @Override
        public void onHold() {
            setOnHold();
            MeetingCall.emit("hold", "");
        }

        @Override
        public void onUnhold() {
            setActive();
            MeetingCall.emit("unhold", "");
        }

        @Override
        public void onDisconnect() {
            finish(DisconnectCause.LOCAL);
            MeetingCall.emit("disconnect", "");
        }

        @Override
        public void onAbort() {
            finish(DisconnectCause.LOCAL);
            MeetingCall.emit("disconnect", "");
        }

        @Override
        public void onCallAudioStateChanged(CallAudioState state) {
            String route;
            switch (state.getRoute()) {
                case CallAudioState.ROUTE_BLUETOOTH: route = "bluetooth"; break;
                case CallAudioState.ROUTE_SPEAKER: route = "speaker"; break;
                case CallAudioState.ROUTE_WIRED_HEADSET: route = "wired"; break;
                default: route = "earpiece";
            }
            MeetingCall.emit("audioRoute", route);
        }

        /** 웹에서 회의를 나갔을 때 — 웹으로 다시 알리지 않는다 */
        void endLocally() {
            finish(DisconnectCause.LOCAL);
        }

        private void finish(int cause) {
            setDisconnected(new DisconnectCause(cause));
            destroy();
            if (MeetingCall.getConnection() == this) MeetingCall.setConnection(null);
        }
    }
}
