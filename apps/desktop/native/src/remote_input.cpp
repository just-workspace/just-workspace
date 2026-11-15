// jw_remote_input — 원격 데스크톱 호스트의 입력 주입(Windows SendInput)과 보안 데스크톱 감지.
//
// 호출하는 쪽(src/main/remote/inject.ts)이 이미 형식·범위·속도를 검사한 값만 넘긴다. 여기서도 한 번 더 자른다.
//  mouseMove(x, y)           x·y = 가상 데스크톱(모든 모니터) 기준 물리 픽셀 좌표
//  mouseButton(b, down)      b 0=왼쪽 1=가운데 2=오른쪽
//  wheel(dx, dy)             픽셀(±1200). WHEEL_DELTA(120) 단위로 그대로 넘긴다
//  key(scancode, ext, down)  하드웨어 스캔코드(Set 1) + 확장키 여부
//  secureDesktop()           입력 데스크톱이 "Default" 가 아니면 true(UAC 동의 창·잠금 화면 = Winlogon).
//                            일반 사용자 프로세스는 그때 캡처·주입이 막힌다 — 뷰어에 알리는 용도
//  virtualScreen()           { x, y, w, h } 가상 데스크톱(물리 픽셀)
// Ctrl+Alt+Del(SAS)은 SendInput 으로 보낼 수 없다(SendSAS + SYSTEM 서비스 필요) — 1단계 범위 밖.
// 다른 OS 는 빌드만 되는 스텁(supported() = false).
#include <napi.h>

#ifdef _WIN32
#include <windows.h>
#endif

namespace {

#ifdef _WIN32
RECT VirtualRect() {
  RECT r;
  r.left = GetSystemMetrics(SM_XVIRTUALSCREEN);
  r.top = GetSystemMetrics(SM_YVIRTUALSCREEN);
  r.right = r.left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
  r.bottom = r.top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
  return r;
}

bool Send(INPUT* in, UINT n) {
  return SendInput(n, in, sizeof(INPUT)) == n;
}
#endif

int Clamp(int v, int lo, int hi) { return v < lo ? lo : (v > hi ? hi : v); }

Napi::Value Supported(const Napi::CallbackInfo& info) {
#ifdef _WIN32
  return Napi::Boolean::New(info.Env(), true);
#else
  return Napi::Boolean::New(info.Env(), false);
#endif
}

Napi::Value VirtualScreen(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Object o = Napi::Object::New(env);
#ifdef _WIN32
  RECT r = VirtualRect();
  o.Set("x", r.left);
  o.Set("y", r.top);
  o.Set("w", r.right - r.left);
  o.Set("h", r.bottom - r.top);
#else
  o.Set("x", 0); o.Set("y", 0); o.Set("w", 0); o.Set("h", 0);
#endif
  return o;
}

Napi::Value MouseMove(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) return Napi::Boolean::New(env, false);
#ifdef _WIN32
  RECT r = VirtualRect();
  const int w = r.right - r.left, h = r.bottom - r.top;
  if (w <= 1 || h <= 1) return Napi::Boolean::New(env, false);
  const int x = Clamp(info[0].As<Napi::Number>().Int32Value(), r.left, r.right - 1);
  const int y = Clamp(info[1].As<Napi::Number>().Int32Value(), r.top, r.bottom - 1);
  INPUT in = {};
  in.type = INPUT_MOUSE;
  // MOUSEEVENTF_VIRTUALDESK: 0..65535 가 가상 데스크톱 전체(멀티 모니터)에 걸친다
  in.mi.dx = static_cast<LONG>(((x - r.left) * 65535LL) / (w - 1));
  in.mi.dy = static_cast<LONG>(((y - r.top) * 65535LL) / (h - 1));
  in.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
  return Napi::Boolean::New(env, Send(&in, 1));
#else
  return Napi::Boolean::New(env, false);
#endif
}

Napi::Value MouseButton(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBoolean()) return Napi::Boolean::New(env, false);
#ifdef _WIN32
  const int b = info[0].As<Napi::Number>().Int32Value();
  const bool down = info[1].As<Napi::Boolean>().Value();
  DWORD f = 0;
  if (b == 0) f = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
  else if (b == 1) f = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
  else if (b == 2) f = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
  else return Napi::Boolean::New(env, false);
  INPUT in = {};
  in.type = INPUT_MOUSE;
  in.mi.dwFlags = f;
  return Napi::Boolean::New(env, Send(&in, 1));
#else
  return Napi::Boolean::New(env, false);
#endif
}

Napi::Value Wheel(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) return Napi::Boolean::New(env, false);
#ifdef _WIN32
  const int dx = Clamp(info[0].As<Napi::Number>().Int32Value(), -1200, 1200);
  const int dy = Clamp(info[1].As<Napi::Number>().Int32Value(), -1200, 1200);
  INPUT in[2] = {};
  UINT n = 0;
  if (dy != 0) {
    in[n].type = INPUT_MOUSE;
    in[n].mi.dwFlags = MOUSEEVENTF_WHEEL;
    in[n].mi.mouseData = static_cast<DWORD>(-dy);  // 브라우저 deltaY>0 = 아래로, Windows 휠 +값 = 위로
    n++;
  }
  if (dx != 0) {
    in[n].type = INPUT_MOUSE;
    in[n].mi.dwFlags = MOUSEEVENTF_HWHEEL;
    in[n].mi.mouseData = static_cast<DWORD>(dx);
    n++;
  }
  return Napi::Boolean::New(env, n == 0 || Send(in, n));
#else
  return Napi::Boolean::New(env, false);
#endif
}

Napi::Value Key(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsBoolean() || !info[2].IsBoolean()) return Napi::Boolean::New(env, false);
#ifdef _WIN32
  const int sc = info[0].As<Napi::Number>().Int32Value();
  if (sc <= 0 || sc > 0xFF) return Napi::Boolean::New(env, false);
  const bool ext = info[1].As<Napi::Boolean>().Value();
  const bool down = info[2].As<Napi::Boolean>().Value();
  INPUT in = {};
  in.type = INPUT_KEYBOARD;
  in.ki.wScan = static_cast<WORD>(sc);
  in.ki.dwFlags = KEYEVENTF_SCANCODE | (ext ? KEYEVENTF_EXTENDEDKEY : 0) | (down ? 0 : KEYEVENTF_KEYUP);
  return Napi::Boolean::New(env, Send(&in, 1));
#else
  return Napi::Boolean::New(env, false);
#endif
}

Napi::Value SecureDesktop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
#ifdef _WIN32
  // 입력 데스크톱을 못 열거나(권한 없음 = Winlogon/보안 데스크톱) 이름이 Default 가 아니면 보안 화면
  HDESK d = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
  if (!d) return Napi::Boolean::New(env, true);
  wchar_t name[64] = {0};
  DWORD needed = 0;
  BOOL ok = GetUserObjectInformationW(d, UOI_NAME, name, sizeof(name), &needed);
  CloseDesktop(d);
  if (!ok) return Napi::Boolean::New(env, true);
  return Napi::Boolean::New(env, _wcsicmp(name, L"Default") != 0);
#else
  return Napi::Boolean::New(env, false);
#endif
}

}  // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("supported", Napi::Function::New(env, Supported));
  exports.Set("virtualScreen", Napi::Function::New(env, VirtualScreen));
  exports.Set("mouseMove", Napi::Function::New(env, MouseMove));
  exports.Set("mouseButton", Napi::Function::New(env, MouseButton));
  exports.Set("wheel", Napi::Function::New(env, Wheel));
  exports.Set("key", Napi::Function::New(env, Key));
  exports.Set("secureDesktop", Napi::Function::New(env, SecureDesktop));
  return exports;
}

NODE_API_MODULE(jw_remote_input, Init)
