package it.justworkspace.mobile;

import android.content.ComponentName;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.telecom.PhoneAccount;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.util.Log;

/**
 * 진행 중인 회의 하나의 네이티브 쪽 상태.
 *
 * 회의 자체(WebRTC)는 웹뷰 안의 LiveKit 이 돌린다. 여기서는 OS 가 그 회의를 "통화"로 알게 해서
 *  - 일반 전화가 오면 회의를 보류(hold)로 돌리고 끝나면 되살리고(Telecom self-managed 통화),
 *  - 화면이 꺼지거나 앱을 내려도 프로세스·마이크가 살아 있게 한다(MeetingService 포그라운드 서비스).
 * 플러그인·서비스·ConnectionService 가 서로 다른 객체라 상태를 여기 한 곳에 둔다.
 */
final class MeetingCall {
    private static final String TAG = "JwMeeting";
    static final String ACCOUNT_ID = "jw-meeting";

    /** 웹으로 올려 보낼 이벤트 (hold / unhold / disconnect / audioRoute / leave) */
    interface Listener {
        void onEvent(String type, String detail);
    }

    private static Listener listener;
    private static MeetingConnectionService.MeetingConnection connection;
    static String title = "";

    private MeetingCall() {}

    static synchronized void setListener(Listener l) { listener = l; }

    static synchronized void emit(String type, String detail) {
        if (listener != null) listener.onEvent(type, detail);
    }

    static synchronized void setConnection(MeetingConnectionService.MeetingConnection c) { connection = c; }

    static synchronized MeetingConnectionService.MeetingConnection getConnection() { return connection; }

    /** Telecom self-managed 통화는 Android 8(API 26)부터 */
    static boolean telecomSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O;
    }

    static PhoneAccountHandle accountHandle(Context ctx) {
        return new PhoneAccountHandle(new ComponentName(ctx, MeetingConnectionService.class), ACCOUNT_ID);
    }

    /** 회의를 OS 통화로 등록한다. 실패해도 회의는 계속된다(포그라운드 서비스만으로 돈다). */
    static boolean placeCall(Context ctx, String roomTitle) {
        if (!telecomSupported()) return false;
        try {
            TelecomManager tm = (TelecomManager) ctx.getSystemService(Context.TELECOM_SERVICE);
            PhoneAccountHandle handle = accountHandle(ctx);
            PhoneAccount account = PhoneAccount.builder(handle, ctx.getString(R.string.app_name))
                .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED)
                .build();
            tm.registerPhoneAccount(account);
            if (!tm.isOutgoingCallPermitted(handle)) {
                // 이미 다른 통화 중 등 — OS 가 지금은 새 통화를 허락하지 않는다
                Log.w(TAG, "outgoing call not permitted now");
                return false;
            }
            Bundle extras = new Bundle();
            extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle);
            tm.placeCall(Uri.fromParts("jw", roomTitle == null ? "meeting" : roomTitle, null), extras);
            return true;
        } catch (SecurityException | IllegalArgumentException e) {
            Log.w(TAG, "placeCall failed", e);
            return false;
        }
    }

    static void endCall() {
        MeetingConnectionService.MeetingConnection c = getConnection();
        if (c != null) c.endLocally();
    }
}
