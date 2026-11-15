// WASAPI 직접 호출(miniaudio 밖): exclusive 포맷 매트릭스 시험, 장치를 쓰는 세션(프로세스) 목록, 장치 기본 형식.
// 장치 id 는 IMMDevice::GetId 의 endpoint id 문자열 — miniaudio 의 ma_device_id.wasapi 와 같다.
#pragma once
#include <string>
#include <vector>

namespace jw {

struct ExclusiveFormat {
  unsigned rate;
  unsigned bits;       // 16 · 24 · 32
  unsigned validBits;  // 24-in-32 컨테이너면 24
  unsigned channels;
  bool isFloat;
};

struct SessionInfo {
  unsigned pid;
  std::string process;  // 실행 파일 이름(권한이 없으면 빈 문자열)
  std::string state;    // active · inactive · expired
  bool isSystemSounds;
};

struct DeviceFormatInfo {
  bool ok = false;
  unsigned rate = 0;
  unsigned bits = 0;
  unsigned validBits = 0;
  unsigned channels = 0;
  bool isFloat = false;
  // 기본 장치 주기(100 ns 단위) — exclusive 최소 주기 추정
  long long defaultPeriod = 0;
  long long minimumPeriod = 0;
};

// kind: true = capture, false = playback. id 가 비면 기본 장치.
std::vector<ExclusiveFormat> probeExclusiveFormats(const std::wstring& id, bool capture,
                                                   const std::vector<unsigned>& rates,
                                                   const std::vector<unsigned>& channelsList);
std::vector<SessionInfo> sessionsOf(const std::wstring& id, bool capture);
DeviceFormatInfo deviceFormat(const std::wstring& id, bool capture);
// HRESULT → 사람이 읽을 코드('device_in_use' · 'exclusive_not_allowed' · 'unsupported_format' · 'access_denied' · 'device_invalidated' · 'hr_xxxxxxxx')
std::string hresultCode(long hr);

}  // namespace jw
