// WASAPI 직접 호출 — miniaudio 가 안 해 주는 세 가지: exclusive 포맷 매트릭스, 장치를 쓰는 프로세스, 장치 기본 형식/주기.
// 모든 함수는 호출 스레드에서 COM 을 (이미 초기화돼 있지 않으면) 멀티스레드 아파트먼트로 초기화하고, 자기가 초기화했으면 되돌린다.
#include "wasapi_probe.h"

#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <functiondiscoverykeys_devpkey.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <ks.h>
#include <ksmedia.h>
#include <psapi.h>

#include <algorithm>
#include <cstdio>

namespace jw {
namespace {

struct ComScope {
  bool uninit = false;
  ComScope() {
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    uninit = SUCCEEDED(hr);  // S_OK 또는 S_FALSE(이미 초기화) → 짝을 맞춰 Uninitialize. RPC_E_CHANGED_MODE 면 건드리지 않는다
    if (hr == RPC_E_CHANGED_MODE) uninit = false;
  }
  ~ComScope() {
    if (uninit) CoUninitialize();
  }
};

template <typename T>
struct ComPtr {
  T* p = nullptr;
  ~ComPtr() {
    if (p) p->Release();
  }
  T** operator&() { return &p; }
  T* operator->() const { return p; }
  explicit operator bool() const { return p != nullptr; }
};

bool getDevice(const std::wstring& id, bool capture, ComPtr<IMMDevice>& dev) {
  ComPtr<IMMDeviceEnumerator> en;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&en))) return false;
  if (id.empty()) {
    return SUCCEEDED(en->GetDefaultAudioEndpoint(capture ? eCapture : eRender, eConsole, &dev));
  }
  return SUCCEEDED(en->GetDevice(id.c_str(), &dev));
}

std::string narrow(const wchar_t* w) {
  if (!w) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return {};
  std::string s(static_cast<size_t>(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}

std::string processName(DWORD pid) {
  if (pid == 0) return "System";
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) return {};
  wchar_t path[MAX_PATH * 2];
  DWORD len = static_cast<DWORD>(sizeof(path) / sizeof(path[0]));
  std::string out;
  if (QueryFullProcessImageNameW(h, 0, path, &len)) {
    std::wstring p(path, len);
    size_t slash = p.find_last_of(L"\\/");
    out = narrow((slash == std::wstring::npos ? p : p.substr(slash + 1)).c_str());
  }
  CloseHandle(h);
  return out;
}

void fillFormat(WAVEFORMATEXTENSIBLE& wf, unsigned rate, unsigned bits, unsigned validBits, unsigned channels, bool isFloat) {
  ZeroMemory(&wf, sizeof(wf));
  wf.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
  wf.Format.nChannels = static_cast<WORD>(channels);
  wf.Format.nSamplesPerSec = rate;
  wf.Format.wBitsPerSample = static_cast<WORD>(bits);
  wf.Format.nBlockAlign = static_cast<WORD>(channels * bits / 8);
  wf.Format.nAvgBytesPerSec = wf.Format.nBlockAlign * rate;
  wf.Format.cbSize = sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX);
  wf.Samples.wValidBitsPerSample = static_cast<WORD>(validBits);
  wf.dwChannelMask = channels == 1 ? SPEAKER_FRONT_CENTER : channels == 2 ? (SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT) : (1u << channels) - 1;
  wf.SubFormat = isFloat ? KSDATAFORMAT_SUBTYPE_IEEE_FLOAT : KSDATAFORMAT_SUBTYPE_PCM;
}

}  // namespace

std::vector<ExclusiveFormat> probeExclusiveFormats(const std::wstring& id, bool capture, const std::vector<unsigned>& rates,
                                                   const std::vector<unsigned>& channelsList) {
  std::vector<ExclusiveFormat> out;
  ComScope com;
  ComPtr<IMMDevice> dev;
  if (!getDevice(id, capture, dev)) return out;
  ComPtr<IAudioClient> client;
  if (FAILED(dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client))) return out;
  struct Cand { unsigned bits, valid; bool f; };
  const Cand cands[] = {{16, 16, false}, {24, 24, false}, {32, 24, false}, {32, 32, false}, {32, 32, true}};
  for (unsigned ch : channelsList) {
    for (unsigned rate : rates) {
      for (const Cand& c : cands) {
        WAVEFORMATEXTENSIBLE wf;
        fillFormat(wf, rate, c.bits, c.valid, ch, c.f);
        HRESULT hr = client->IsFormatSupported(AUDCLNT_SHAREMODE_EXCLUSIVE, &wf.Format, nullptr);
        if (hr == S_OK) out.push_back({rate, c.bits, c.valid, ch, c.f});
      }
    }
  }
  return out;
}

std::vector<SessionInfo> sessionsOf(const std::wstring& id, bool capture) {
  std::vector<SessionInfo> out;
  ComScope com;
  ComPtr<IMMDevice> dev;
  if (!getDevice(id, capture, dev)) return out;
  ComPtr<IAudioSessionManager2> mgr;
  if (FAILED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&mgr))) return out;
  ComPtr<IAudioSessionEnumerator> en;
  if (FAILED(mgr->GetSessionEnumerator(&en))) return out;
  int count = 0;
  en->GetCount(&count);
  const DWORD self = GetCurrentProcessId();
  for (int i = 0; i < count; i++) {
    ComPtr<IAudioSessionControl> ctl;
    if (FAILED(en->GetSession(i, &ctl))) continue;
    ComPtr<IAudioSessionControl2> ctl2;
    if (FAILED(ctl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&ctl2))) continue;
    DWORD pid = 0;
    ctl2->GetProcessId(&pid);
    if (pid == self) continue;
    AudioSessionState st = AudioSessionStateInactive;
    ctl->GetState(&st);
    SessionInfo s;
    s.pid = pid;
    s.process = processName(pid);
    s.state = st == AudioSessionStateActive ? "active" : st == AudioSessionStateExpired ? "expired" : "inactive";
    s.isSystemSounds = ctl2->IsSystemSoundsSession() == S_OK;
    out.push_back(s);
  }
  return out;
}

DeviceFormatInfo deviceFormat(const std::wstring& id, bool capture) {
  DeviceFormatInfo info;
  ComScope com;
  ComPtr<IMMDevice> dev;
  if (!getDevice(id, capture, dev)) return info;
  ComPtr<IPropertyStore> store;
  if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &store))) {
    PROPVARIANT v;
    PropVariantInit(&v);
    if (SUCCEEDED(store->GetValue(PKEY_AudioEngine_DeviceFormat, &v)) && v.vt == VT_BLOB && v.blob.pBlobData) {
      const WAVEFORMATEX* wf = reinterpret_cast<const WAVEFORMATEX*>(v.blob.pBlobData);
      info.ok = true;
      info.rate = wf->nSamplesPerSec;
      info.bits = wf->wBitsPerSample;
      info.validBits = wf->wBitsPerSample;
      info.channels = wf->nChannels;
      info.isFloat = wf->wFormatTag == WAVE_FORMAT_IEEE_FLOAT;
      if (wf->wFormatTag == WAVE_FORMAT_EXTENSIBLE && wf->cbSize >= 22) {
        const WAVEFORMATEXTENSIBLE* ex = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(wf);
        info.validBits = ex->Samples.wValidBitsPerSample;
        info.isFloat = IsEqualGUID(ex->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) != 0;
      }
    }
    PropVariantClear(&v);
  }
  ComPtr<IAudioClient> client;
  if (SUCCEEDED(dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)&client))) {
    REFERENCE_TIME def = 0, mn = 0;
    if (SUCCEEDED(client->GetDevicePeriod(&def, &mn))) {
      info.defaultPeriod = def;
      info.minimumPeriod = mn;
    }
  }
  return info;
}

std::string hresultCode(long hr) {
  switch (static_cast<HRESULT>(hr)) {
    case 0: return "";
    case AUDCLNT_E_DEVICE_IN_USE: return "device_in_use";
    case AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED: return "exclusive_not_allowed";
    case AUDCLNT_E_UNSUPPORTED_FORMAT: return "unsupported_format";
    case AUDCLNT_E_DEVICE_INVALIDATED: return "device_invalidated";
    case AUDCLNT_E_ENDPOINT_CREATE_FAILED: return "endpoint_create_failed";
    case AUDCLNT_E_SERVICE_NOT_RUNNING: return "audio_service_not_running";
    case AUDCLNT_E_INVALID_DEVICE_PERIOD: return "invalid_device_period";
    case AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED: return "buffer_not_aligned";
    case E_ACCESSDENIED: return "access_denied";
    case S_FALSE: return "unsupported_format";  // IsFormatSupported S_FALSE = 가까운 포맷 제안(exclusive 에선 거부)
    default: {
      char buf[32];
      std::snprintf(buf, sizeof(buf), "hr_%08lx", static_cast<unsigned long>(hr));
      return buf;
    }
  }
}

}  // namespace jw
