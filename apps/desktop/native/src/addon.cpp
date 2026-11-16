// jw_native_audio — Node-API 애드온(Electron 44 / Node 24, N-API 8).
//
//  · miniaudio(WASAPI exclusive/shared, null 백엔드) 로 캡처·재생 장치를 요청 포맷(s16/s24/s32/f32 × 레이트 × 채널)으로 연다.
//  · 오디오 스레드 ↔ JS 간 데이터 교환은 SPSC 락프리 링버퍼(ring_buffer.h)로만 수행한다. 캡처는 "데이터 있음" 신호를 TSFN(큐 1, 비차단)으로
//    병합하여 통지하고 JS 가 read() 로 읽는다. 재생은 JS 가 write() 로 기록하고 콜백이 읽는다(부족하면 0 채움 + underrun 집계).
//  · exclusive 실패 사유는 패치된 miniaudio 가 기록한 HRESULT(ma_jw_wasapi_last_hr) 로 구분한다. 장치를 사용 중인 다른 프로세스는
//    wasapi_probe.cpp 의 세션 열거로 식별한다.
//  · 테스트: null 백엔드 + 결정적 신호 생성기(testSignal) 로 실제 장치 없이 전체 경로를 실행한다.
//  · speexdsp 리샘플러(BSD) 는 수신 스트림 레이트 != 재생 장치 레이트일 때만 JS 가 사용한다.
#define _USE_MATH_DEFINES
#include <cmath>
#include <windows.h>
#include <napi.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

#include "miniaudio.h"
#include "ring_buffer.h"
#include "wasapi_probe.h"

extern "C" long ma_jw_wasapi_last_hr(void);
extern "C" void ma_jw_wasapi_reset_last_hr(void);

#include "speex_resampler.h"

namespace {

// ───────────────────────── 공통 유틸 ─────────────────────────

std::wstring widen(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, nullptr, 0);
  if (n <= 1) return {};
  std::wstring w(static_cast<size_t>(n - 1), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), -1, w.data(), n);
  return w;
}

std::string narrow(const wchar_t* w) {
  if (!w || !*w) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
  if (n <= 1) return {};
  std::string s(static_cast<size_t>(n - 1), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
  return s;
}

const char* formatName(ma_format f) {
  switch (f) {
    case ma_format_u8: return "u8";
    case ma_format_s16: return "s16";
    case ma_format_s24: return "s24";
    case ma_format_s32: return "s32";
    case ma_format_f32: return "f32";
    default: return "unknown";
  }
}

ma_format formatFrom(const std::string& s) {
  if (s == "s16") return ma_format_s16;
  if (s == "s24") return ma_format_s24;
  if (s == "s32") return ma_format_s32;
  if (s == "f32") return ma_format_f32;
  if (s == "u8") return ma_format_u8;
  return ma_format_unknown;
}

// 백엔드별 컨텍스트(지연 생성). WASAPI 와 null 을 분리하여 테스트가 실제 장치에 접근하지 않도록 한다.
struct Ctx {
  ma_context ctx{};
  bool inited = false;
  ma_backend backend = ma_backend_wasapi;
  std::mutex mu;
};
Ctx g_wasapi, g_null;

Ctx* contextFor(const std::string& backend, std::string* err) {
  Ctx* c = backend == "null" ? &g_null : &g_wasapi;
  std::lock_guard<std::mutex> lk(c->mu);
  if (!c->inited) {
    ma_backend be = backend == "null" ? ma_backend_null : ma_backend_wasapi;
    ma_context_config cfg = ma_context_config_init();
    cfg.threadPriority = ma_thread_priority_realtime;
    ma_result r = ma_context_init(&be, 1, &cfg, &c->ctx);
    if (r != MA_SUCCESS) {
      if (err) *err = std::string("ma_context_init failed: ") + ma_result_description(r);
      return nullptr;
    }
    c->backend = be;
    c->inited = true;
  }
  return c;
}

std::string deviceIdToString(ma_backend be, const ma_device_id& id) {
  if (be == ma_backend_wasapi) return narrow(id.wasapi);
  if (be == ma_backend_null) return "null:" + std::to_string(id.nullbackend);
  return {};
}

bool deviceIdFromString(ma_backend be, const std::string& s, ma_device_id* out) {
  std::memset(out, 0, sizeof(*out));
  if (s.empty()) return false;
  if (be == ma_backend_wasapi) {
    std::wstring w = widen(s);
    if (w.size() >= 64) return false;
    std::wcsncpy(out->wasapi, w.c_str(), 63);
    return true;
  }
  if (be == ma_backend_null) {
    out->nullbackend = std::atoi(s.rfind("null:", 0) == 0 ? s.c_str() + 5 : s.c_str());
    return true;
  }
  return false;
}

Napi::Object deviceInfoToJs(Napi::Env env, ma_backend be, ma_device_type type, const ma_device_info& info) {
  Napi::Object o = Napi::Object::New(env);
  o.Set("id", deviceIdToString(be, info.id));
  o.Set("name", info.name);
  o.Set("isDefault", info.isDefault != 0);
  o.Set("kind", type == ma_device_type_capture ? "capture" : "playback");
  Napi::Array fmts = Napi::Array::New(env);
  for (ma_uint32 i = 0; i < info.nativeDataFormatCount; i++) {
    const auto& f = info.nativeDataFormats[i];
    Napi::Object fo = Napi::Object::New(env);
    fo.Set("format", formatName(f.format));
    fo.Set("channels", f.channels);
    fo.Set("sampleRate", f.sampleRate);
    fo.Set("exclusive", (f.flags & MA_DATA_FORMAT_FLAG_EXCLUSIVE_MODE) != 0);
    fmts.Set(i, fo);
  }
  o.Set("nativeFormats", fmts);
  return o;
}

std::string optString(const Napi::Object& o, const char* k, const std::string& def) {
  if (!o.Has(k)) return def;
  Napi::Value v = o.Get(k);
  return v.IsString() ? v.As<Napi::String>().Utf8Value() : def;
}
uint32_t optU32(const Napi::Object& o, const char* k, uint32_t def) {
  if (!o.Has(k)) return def;
  Napi::Value v = o.Get(k);
  return v.IsNumber() ? v.As<Napi::Number>().Uint32Value() : def;
}
bool optBool(const Napi::Object& o, const char* k, bool def) {
  if (!o.Has(k)) return def;
  Napi::Value v = o.Get(k);
  return v.IsBoolean() ? v.As<Napi::Boolean>().Value() : def;
}

// ───────────────────────── 장치 ─────────────────────────

class Device : public Napi::ObjectWrap<Device> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "Device", {
      InstanceMethod("start", &Device::Start),
      InstanceMethod("stop", &Device::Stop),
      InstanceMethod("close", &Device::Close),
      InstanceMethod("info", &Device::Info),
      InstanceMethod("stats", &Device::Stats),
      InstanceMethod("read", &Device::Read),
      InstanceMethod("available", &Device::Available),
      InstanceMethod("write", &Device::Write),
      InstanceMethod("queued", &Device::Queued),
      InstanceMethod("clear", &Device::Clear),
      InstanceMethod("setDataCallback", &Device::SetDataCallback),
      InstanceMethod("ringCapacity", &Device::RingCapacity),
    });
  }

  explicit Device(const Napi::CallbackInfo& ci) : Napi::ObjectWrap<Device>(ci) {
    Napi::Env env = ci.Env();
    if (ci.Length() < 1 || !ci[0].IsObject()) {
      Napi::TypeError::New(env, "Device(options) requires an options object").ThrowAsJavaScriptException();
      return;
    }
    Napi::Object o = ci[0].As<Napi::Object>();
    const std::string kind = optString(o, "kind", "capture");
    const std::string backend = optString(o, "backend", "wasapi");
    const std::string deviceId = optString(o, "deviceId", "");
    const std::string fmt = optString(o, "format", "s24");
    channels_ = optU32(o, "channels", 2);
    sampleRate_ = optU32(o, "sampleRate", 48000);
    periodFrames_ = optU32(o, "periodFrames", sampleRate_ / 100);
    const uint32_t periods = optU32(o, "periods", 2);
    exclusive_ = optBool(o, "exclusive", true);
    const uint32_t ringFrames = optU32(o, "ringFrames", sampleRate_ / 2);  // 기본 500 ms
    testSignal_ = optString(o, "testSignal", "none");
    seed_ = optU32(o, "seed", 1);
    const std::string usage = optString(o, "wasapiUsage", "pro_audio");

    capture_ = kind == "capture";
    format_ = formatFrom(fmt);
    if (format_ == ma_format_unknown || channels_ == 0 || sampleRate_ == 0) {
      Napi::TypeError::New(env, "invalid format/channels/sampleRate").ThrowAsJavaScriptException();
      return;
    }
    std::string err;
    ctx_ = contextFor(backend, &err);
    if (!ctx_) {
      Napi::Error::New(env, err).ThrowAsJavaScriptException();
      return;
    }
    bps_ = ma_get_bytes_per_sample(format_);
    frameBytes_ = bps_ * channels_;
    ring_ = std::make_unique<RingBuffer>(static_cast<size_t>(ringFrames) * frameBytes_);
    scratchF32_.resize(static_cast<size_t>(periodFrames_) * 8 * channels_);
    peak_.assign(channels_, 0.0f);
    rms_.assign(channels_, 0.0f);

    ma_device_config cfg = ma_device_config_init(capture_ ? ma_device_type_capture : ma_device_type_playback);
    ma_device_id id{};
    const bool haveId = deviceIdFromString(ctx_->backend, deviceId, &id);
    if (capture_) {
      cfg.capture.pDeviceID = haveId ? &id : nullptr;
      cfg.capture.format = format_;
      cfg.capture.channels = channels_;
      cfg.capture.shareMode = exclusive_ ? ma_share_mode_exclusive : ma_share_mode_shared;
    } else {
      cfg.playback.pDeviceID = haveId ? &id : nullptr;
      cfg.playback.format = format_;
      cfg.playback.channels = channels_;
      cfg.playback.shareMode = exclusive_ ? ma_share_mode_exclusive : ma_share_mode_shared;
    }
    cfg.sampleRate = sampleRate_;
    cfg.periodSizeInFrames = periodFrames_;
    cfg.periods = periods;
    cfg.performanceProfile = ma_performance_profile_low_latency;
    cfg.noPreSilencedOutputBuffer = MA_TRUE;
    cfg.noClip = MA_TRUE;
    cfg.noFixedSizedCallback = MA_FALSE;  // 콜백마다 periodSizeInFrames 로 고정 — 프레임 경계 일정
    cfg.wasapi.noAutoConvertSRC = MA_TRUE;
    cfg.wasapi.noDefaultQualitySRC = MA_TRUE;
    cfg.wasapi.noHardwareOffloading = MA_TRUE;
    cfg.wasapi.usage = usage == "games" ? ma_wasapi_usage_games : ma_wasapi_usage_pro_audio;
    cfg.dataCallback = &Device::DataCallbackStatic;
    cfg.notificationCallback = &Device::NotificationStatic;
    cfg.pUserData = this;

    ma_jw_wasapi_reset_last_hr();
    ma_result r = ma_device_init(&ctx_->ctx, &cfg, &dev_);
    if (r != MA_SUCCESS) {
      const long hr = ma_jw_wasapi_last_hr();
      std::string code = jw::hresultCode(hr);
      if (code.empty()) {
        code = r == MA_BUSY ? "device_in_use"
             : r == MA_SHARE_MODE_NOT_SUPPORTED ? "exclusive_not_supported"
             : r == MA_FORMAT_NOT_SUPPORTED ? "unsupported_format"
             : r == MA_NO_DEVICE || r == MA_DOES_NOT_EXIST ? "no_device"
             : r == MA_ACCESS_DENIED ? "access_denied"
             : std::string("ma_") + std::to_string(static_cast<int>(r));
      }
      Napi::Error e = Napi::Error::New(env, std::string("ma_device_init: ") + ma_result_description(r) + " (" + code + ")");
      e.Set("code", code);
      e.Set("maResult", Napi::Number::New(env, static_cast<int>(r)));
      e.Set("hr", Napi::Number::New(env, static_cast<double>(static_cast<unsigned long>(hr))));
      e.Set("exclusive", Napi::Boolean::New(env, exclusive_));
      e.ThrowAsJavaScriptException();
      return;
    }
    opened_ = true;
  }

  ~Device() override { CloseInternal(); }

 private:
  // ─── 오디오 스레드 ───
  static void DataCallbackStatic(ma_device* d, void* out, const void* in, ma_uint32 frames) {
    static_cast<Device*>(d->pUserData)->OnData(out, in, frames);
  }
  static void NotificationStatic(const ma_device_notification* n) {
    auto* self = static_cast<Device*>(n->pDevice->pUserData);
    if (n->type == ma_device_notification_type_stopped) self->stoppedByBackend_.store(true);
    if (n->type == ma_device_notification_type_interruption_began) self->interrupted_.store(true);
    if (n->type == ma_device_notification_type_rerouted) self->rerouted_.fetch_add(1);
  }

  void OnData(void* out, const void* in, ma_uint32 frames) {
    callbacks_.fetch_add(1, std::memory_order_relaxed);
    framesProcessed_.fetch_add(frames, std::memory_order_relaxed);
    const size_t bytes = static_cast<size_t>(frames) * frameBytes_;
    if (capture_) {
      const uint8_t* src = static_cast<const uint8_t*>(in);
      if (testSignal_ != "none") {
        src = GenerateTest(frames);
      }
      if (src) {
        Levels(src, frames);
        if (ring_->write(src, bytes) == 0) overruns_.fetch_add(1, std::memory_order_relaxed);
      }
      if (tsfn_ && !pending_.exchange(true, std::memory_order_acq_rel)) {
        if (tsfn_.NonBlockingCall() != napi_ok) pending_.store(false, std::memory_order_release);
      }
    } else {
      uint8_t* dst = static_cast<uint8_t*>(out);
      const size_t got = ring_->read(dst, bytes);
      if (got < bytes) {
        std::memset(dst + got, 0, bytes - got);  // s16/s24/s32/f32 모두 0 = 무음
        underruns_.fetch_add(1, std::memory_order_relaxed);
        underrunFrames_.fetch_add(static_cast<uint64_t>((bytes - got) / frameBytes_), std::memory_order_relaxed);
      }
      Levels(dst, frames);
    }
  }

  // 채널별 peak/rms (오디오 스레드, 할당 없음)
  void Levels(const uint8_t* pcm, ma_uint32 frames) {
    const size_t need = static_cast<size_t>(frames) * channels_;
    if (need > scratchF32_.size()) frames = static_cast<ma_uint32>(scratchF32_.size() / channels_);
    ma_pcm_convert(scratchF32_.data(), ma_format_f32, pcm, format_, static_cast<ma_uint64>(frames) * channels_, ma_dither_mode_none);
    for (uint32_t c = 0; c < channels_; c++) {
      float p = 0.f;
      double s = 0.0;
      for (ma_uint32 i = 0; i < frames; i++) {
        const float v = scratchF32_[static_cast<size_t>(i) * channels_ + c];
        const float a = std::fabs(v);
        if (a > p) p = a;
        s += static_cast<double>(v) * v;
      }
      peak_[c] = p;
      rms_[c] = frames ? static_cast<float>(std::sqrt(s / frames)) : 0.f;
    }
  }

  // 결정적 테스트 신호: 채널 c = 1 kHz × (1 + 0.1·c) 톤 + 느린 스위프 + xorshift LSB 노이즈 → 요청 포맷으로 변환
  const uint8_t* GenerateTest(ma_uint32 frames) {
    const size_t need = static_cast<size_t>(frames) * channels_;
    if (genF32_.size() < need) genF32_.resize(need);
    if (genBytes_.size() < need * bps_) genBytes_.resize(need * bps_);
    const double sr = static_cast<double>(sampleRate_);
    for (ma_uint32 i = 0; i < frames; i++) {
      const uint64_t n = genPos_ + i;
      const double t = static_cast<double>(n) / sr;
      for (uint32_t c = 0; c < channels_; c++) {
        double v;
        if (testSignal_ == "ramp") {
          v = static_cast<double>((n * (c + 1)) % 1000) / 500.0 - 1.0;
        } else if (testSignal_ == "noise") {
          v = static_cast<double>(static_cast<int32_t>(XorShift())) / 2147483648.0 * 0.5;
        } else {  // sweep
          const double f = 1000.0 * (1.0 + 0.1 * c) + 200.0 * std::sin(2 * M_PI * 0.2 * t);
          v = 0.5 * std::sin(2 * M_PI * f * t) + (static_cast<double>(static_cast<int32_t>(XorShift())) / 2147483648.0) * (1.0 / 4096.0);
        }
        if (v > 0.999999) v = 0.999999;
        if (v < -0.999999) v = -0.999999;
        genF32_[static_cast<size_t>(i) * channels_ + c] = static_cast<float>(v);
      }
    }
    genPos_ += frames;
    ma_pcm_convert(genBytes_.data(), format_, genF32_.data(), ma_format_f32, static_cast<ma_uint64>(frames) * channels_, ma_dither_mode_none);
    return genBytes_.data();
  }
  uint32_t XorShift() {
    uint32_t x = seed_;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    seed_ = x ? x : 0x9e3779b9u;
    return x;
  }

  // ─── JS 스레드 ───
  Napi::Value Start(const Napi::CallbackInfo& ci) {
    Napi::Env env = ci.Env();
    if (!opened_) { Napi::Error::New(env, "device closed").ThrowAsJavaScriptException(); return env.Undefined(); }
    ma_result r = ma_device_start(&dev_);
    if (r != MA_SUCCESS) { Napi::Error::New(env, std::string("ma_device_start: ") + ma_result_description(r)).ThrowAsJavaScriptException(); }
    return env.Undefined();
  }
  Napi::Value Stop(const Napi::CallbackInfo& ci) {
    if (opened_ && ma_device_is_started(&dev_)) ma_device_stop(&dev_);
    return ci.Env().Undefined();
  }
  Napi::Value Close(const Napi::CallbackInfo& ci) {
    CloseInternal();
    return ci.Env().Undefined();
  }
  void CloseInternal() {
    if (opened_) {
      ma_device_uninit(&dev_);  // 콜백 스레드 정지 후 반환된다
      opened_ = false;
    }
    if (tsfn_) {
      tsfn_.Release();
      tsfn_ = Napi::ThreadSafeFunction();
    }
  }

  template <typename Side>
  void FillSide(Napi::Object& o, const Side& s) {
    o.Set("name", s.name);
    o.Set("deviceId", deviceIdToString(ctx_->backend, s.id));
    o.Set("shareMode", s.shareMode == ma_share_mode_exclusive ? "exclusive" : "shared");
    o.Set("internalFormat", formatName(s.internalFormat));
    o.Set("internalBits", ma_get_bytes_per_sample(s.internalFormat) * 8);
    o.Set("internalChannels", s.internalChannels);
    o.Set("internalSampleRate", s.internalSampleRate);
    o.Set("internalPeriodFrames", s.internalPeriodSizeInFrames);
    o.Set("internalPeriods", s.internalPeriods);
    // miniaudio 변환기 개입 여부 — 24-in-32(s32→s24, >>8) 는 무손실이므로 bitPerfect 판정에서 별도로 처리한다
    const bool sameRate = s.internalSampleRate == sampleRate_;
    const bool sameCh = s.internalChannels == channels_;
    const bool sameFmt = s.internalFormat == format_;
    const bool lossless24in32 = s.internalFormat == ma_format_s32 && format_ == ma_format_s24;
    o.Set("converterActive", !(sameRate && sameCh && sameFmt));
    o.Set("bitPerfect", s.shareMode == ma_share_mode_exclusive && sameRate && sameCh && (sameFmt || lossless24in32));
  }

  Napi::Value Info(const Napi::CallbackInfo& ci) {
    Napi::Env env = ci.Env();
    Napi::Object o = Napi::Object::New(env);
    o.Set("kind", capture_ ? "capture" : "playback");
    o.Set("backend", ctx_ ? ma_get_backend_name(ctx_->backend) : "");
    o.Set("open", opened_);
    o.Set("started", opened_ && ma_device_is_started(&dev_));
    o.Set("format", formatName(format_));
    o.Set("bits", bps_ * 8);
    o.Set("channels", channels_);
    o.Set("sampleRate", sampleRate_);
    o.Set("periodFrames", periodFrames_);
    o.Set("exclusive", exclusive_);
    o.Set("frameBytes", frameBytes_);
    if (opened_) {
      if (capture_) FillSide(o, dev_.capture); else FillSide(o, dev_.playback);
      o.Set("testSignal", testSignal_);
    }
    return o;
  }

  Napi::Value Stats(const Napi::CallbackInfo& ci) {
    Napi::Env env = ci.Env();
    Napi::Object o = Napi::Object::New(env);
    o.Set("callbacks", Napi::Number::New(env, static_cast<double>(callbacks_.load())));
    o.Set("framesProcessed", Napi::Number::New(env, static_cast<double>(framesProcessed_.load())));
    o.Set("overruns", Napi::Number::New(env, static_cast<double>(overruns_.load())));
    o.Set("underruns", Napi::Number::New(env, static_cast<double>(underruns_.load())));
    o.Set("underrunFrames", Napi::Number::New(env, static_cast<double>(underrunFrames_.load())));
    o.Set("ringBytes", Napi::Number::New(env, static_cast<double>(ring_ ? ring_->available() : 0)));
    o.Set("ringCapacityBytes", Napi::Number::New(env, static_cast<double>(ring_ ? ring_->capacity() : 0)));
    o.Set("stoppedByBackend", stoppedByBackend_.load());
    o.Set("interrupted", interrupted_.load());
    o.Set("rerouted", Napi::Number::New(env, static_cast<double>(rerouted_.load())));
    Napi::Array pk = Napi::Array::New(env), rm = Napi::Array::New(env);
    for (uint32_t c = 0; c < channels_; c++) {
      pk.Set(c, Napi::Number::New(env, peak_[c]));
      rm.Set(c, Napi::Number::New(env, rms_[c]));
    }
    o.Set("peak", pk);
    o.Set("rms", rm);
    return o;
  }

  Napi::Value Read(const Napi::CallbackInfo& ci) {
    Napi::Env env = ci.Env();
    if (ci.Length() < 1 || !ci[0].IsTypedArray()) { Napi::TypeError::New(env, "read(Uint8Array)").ThrowAsJavaScriptException(); return env.Undefined(); }
    Napi::TypedArray ta = ci[0].As<Napi::TypedArray>();
    uint8_t* dst = static_cast<uint8_t*>(ta.ArrayBuffer().Data()) + ta.ByteOffset();
    size_t n = ta.ByteLength();
    size_t got = ring_ ? ring_->read(dst, n) : 0;
    return Napi::Number::New(env, static_cast<double>(got));
  }
  Napi::Value Available(const Napi::CallbackInfo& ci) {
    return Napi::Number::New(ci.Env(), static_cast<double>(ring_ ? ring_->available() : 0));
  }
  Napi::Value Write(const Napi::CallbackInfo& ci) {
    Napi::Env env = ci.Env();
    if (ci.Length() < 1 || !ci[0].IsTypedArray()) { Napi::TypeError::New(env, "write(Uint8Array)").ThrowAsJavaScriptException(); return env.Undefined(); }
    Napi::TypedArray ta = ci[0].As<Napi::TypedArray>();
    const uint8_t* src = static_cast<const uint8_t*>(ta.ArrayBuffer().Data()) + ta.ByteOffset();
    size_t n = ring_ ? ring_->write(src, ta.ByteLength()) : 0;
    return Napi::Number::New(env, static_cast<double>(n));
  }
  Napi::Value Queued(const Napi::CallbackInfo& ci) {
    return Napi::Number::New(ci.Env(), static_cast<double>(ring_ ? ring_->available() : 0));
  }
  Napi::Value Clear(const Napi::CallbackInfo& ci) {
    if (ring_) ring_->discard(ring_->available());
    return ci.Env().Undefined();
  }
  Napi::Value RingCapacity(const Napi::CallbackInfo& ci) {
    return Napi::Number::New(ci.Env(), static_cast<double>(ring_ ? ring_->capacity() : 0));
  }

  // 캡처 "데이터 있음" 알림. 사용자 콜백은 인자 없이 호출된다 — JS 가 read()/available() 로 읽는다.
  // pending_ 은 콜백 직전에 해제한다: 콜백 도중 수신된 새 데이터가 다음 알림을 생성할 수 있도록 하기 위함.
  Napi::Value SetDataCallback(const Napi::CallbackInfo& ci) {
    Napi::Env env = ci.Env();
    if (tsfn_) { tsfn_.Release(); tsfn_ = Napi::ThreadSafeFunction(); }
    userFn_.Reset();
    if (ci.Length() >= 1 && ci[0].IsFunction()) {
      userFn_ = Napi::Persistent(ci[0].As<Napi::Function>());
      Napi::Function wrapper = Napi::Function::New(env, [this](const Napi::CallbackInfo& info) {
        pending_.store(false, std::memory_order_release);
        if (!userFn_.IsEmpty()) userFn_.Call({});
      });
      tsfn_ = Napi::ThreadSafeFunction::New(env, wrapper, "jw-native-audio-data", 1, 1);
      tsfn_.Unref(env);  // 장치가 열려 있어도 프로세스 종료를 차단하지 않는다
    }
    return env.Undefined();
  }

  Ctx* ctx_ = nullptr;
  ma_device dev_{};
  bool opened_ = false;
  bool capture_ = true;
  bool exclusive_ = true;
  ma_format format_ = ma_format_s24;
  uint32_t channels_ = 2, sampleRate_ = 48000, periodFrames_ = 480, bps_ = 3, frameBytes_ = 6;
  std::unique_ptr<RingBuffer> ring_;
  std::vector<float> scratchF32_;
  std::vector<float> peak_, rms_;
  std::atomic<uint64_t> callbacks_{0}, framesProcessed_{0}, overruns_{0}, underruns_{0}, underrunFrames_{0};
  std::atomic<uint32_t> rerouted_{0};
  std::atomic<bool> stoppedByBackend_{false}, interrupted_{false}, pending_{false};
  Napi::ThreadSafeFunction tsfn_;
  Napi::FunctionReference userFn_;
  // 테스트 신호
  std::string testSignal_ = "none";
  uint32_t seed_ = 1;
  uint64_t genPos_ = 0;
  std::vector<float> genF32_;
  std::vector<uint8_t> genBytes_;
};

// ───────────────────────── 리샘플러(speexdsp) ─────────────────────────

class Resampler : public Napi::ObjectWrap<Resampler> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "Resampler", {
      InstanceMethod("process", &Resampler::Process),
      InstanceMethod("latency", &Resampler::Latency),
      InstanceMethod("reset", &Resampler::Reset),
      InstanceMethod("destroy", &Resampler::Destroy),
    });
  }
  explicit Resampler(const Napi::CallbackInfo& ci) : Napi::ObjectWrap<Resampler>(ci) {
    Napi::Env env = ci.Env();
    if (ci.Length() < 3) { Napi::TypeError::New(env, "Resampler(channels, inRate, outRate, quality?)").ThrowAsJavaScriptException(); return; }
    channels_ = ci[0].As<Napi::Number>().Uint32Value();
    inRate_ = ci[1].As<Napi::Number>().Uint32Value();
    outRate_ = ci[2].As<Napi::Number>().Uint32Value();
    int quality = ci.Length() >= 4 && ci[3].IsNumber() ? ci[3].As<Napi::Number>().Int32Value() : 8;
    int err = 0;
    st_ = speex_resampler_init(channels_, inRate_, outRate_, quality, &err);
    if (!st_) { Napi::Error::New(env, std::string("speex_resampler_init: ") + speex_resampler_strerror(err)).ThrowAsJavaScriptException(); }
  }
  ~Resampler() override { if (st_) speex_resampler_destroy(st_); }

 private:
  Napi::Value Process(const Napi::CallbackInfo& ci) {
    Napi::Env env = ci.Env();
    if (!st_) { Napi::Error::New(env, "destroyed").ThrowAsJavaScriptException(); return env.Undefined(); }
    if (ci.Length() < 1 || !ci[0].IsTypedArray() || ci[0].As<Napi::TypedArray>().TypedArrayType() != napi_float32_array) {
      Napi::TypeError::New(env, "process(Float32Array interleaved)").ThrowAsJavaScriptException();
      return env.Undefined();
    }
    Napi::Float32Array in = ci[0].As<Napi::Float32Array>();
    spx_uint32_t inFrames = static_cast<spx_uint32_t>(in.ElementLength() / channels_);
    spx_uint32_t outCap = static_cast<spx_uint32_t>(static_cast<double>(inFrames) * outRate_ / inRate_) + 64;
    Napi::Float32Array out = Napi::Float32Array::New(env, static_cast<size_t>(outCap) * channels_);
    spx_uint32_t outFrames = outCap;
    speex_resampler_process_interleaved_float(st_, in.Data(), &inFrames, out.Data(), &outFrames);
    // 실제 길이로 잘라 반환한다
    return Napi::Float32Array::New(env, static_cast<size_t>(outFrames) * channels_, out.ArrayBuffer(), 0);
  }
  Napi::Value Latency(const Napi::CallbackInfo& ci) {
    Napi::Env env = ci.Env();
    Napi::Object o = Napi::Object::New(env);
    o.Set("inputFrames", st_ ? speex_resampler_get_input_latency(st_) : 0);
    o.Set("outputFrames", st_ ? speex_resampler_get_output_latency(st_) : 0);
    return o;
  }
  Napi::Value Reset(const Napi::CallbackInfo& ci) { if (st_) speex_resampler_reset_mem(st_); return ci.Env().Undefined(); }
  Napi::Value Destroy(const Napi::CallbackInfo& ci) { if (st_) { speex_resampler_destroy(st_); st_ = nullptr; } return ci.Env().Undefined(); }

  SpeexResamplerState* st_ = nullptr;
  uint32_t channels_ = 2, inRate_ = 48000, outRate_ = 48000;
};

// ───────────────────────── 링버퍼 단위 테스트용 래퍼 ─────────────────────────

class RingTest : public Napi::ObjectWrap<RingTest> {
 public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "RingTest", {
      InstanceMethod("write", &RingTest::Write),
      InstanceMethod("read", &RingTest::Read),
      InstanceMethod("discard", &RingTest::Discard),
      InstanceMethod("available", &RingTest::Available),
      InstanceMethod("capacity", &RingTest::Capacity),
      InstanceMethod("reset", &RingTest::Reset),
    });
  }
  explicit RingTest(const Napi::CallbackInfo& ci) : Napi::ObjectWrap<RingTest>(ci), ring_(ci.Length() >= 1 ? ci[0].As<Napi::Number>().Uint32Value() : 1024) {}

 private:
  static std::pair<uint8_t*, size_t> bytesOf(const Napi::Value& v) {
    Napi::TypedArray ta = v.As<Napi::TypedArray>();
    return { static_cast<uint8_t*>(ta.ArrayBuffer().Data()) + ta.ByteOffset(), ta.ByteLength() };
  }
  Napi::Value Write(const Napi::CallbackInfo& ci) { auto [p, n] = bytesOf(ci[0]); return Napi::Number::New(ci.Env(), static_cast<double>(ring_.write(p, n))); }
  Napi::Value Read(const Napi::CallbackInfo& ci) { auto [p, n] = bytesOf(ci[0]); return Napi::Number::New(ci.Env(), static_cast<double>(ring_.read(p, n))); }
  Napi::Value Discard(const Napi::CallbackInfo& ci) { return Napi::Number::New(ci.Env(), static_cast<double>(ring_.discard(ci[0].As<Napi::Number>().Uint32Value()))); }
  Napi::Value Available(const Napi::CallbackInfo& ci) { return Napi::Number::New(ci.Env(), static_cast<double>(ring_.available())); }
  Napi::Value Capacity(const Napi::CallbackInfo& ci) { return Napi::Number::New(ci.Env(), static_cast<double>(ring_.capacity())); }
  Napi::Value Reset(const Napi::CallbackInfo& ci) { ring_.reset(); return ci.Env().Undefined(); }
  RingBuffer ring_;
};

// ───────────────────────── 모듈 함수 ─────────────────────────

Napi::Value ListDevices(const Napi::CallbackInfo& ci) {
  Napi::Env env = ci.Env();
  std::string backend = ci.Length() >= 1 && ci[0].IsString() ? ci[0].As<Napi::String>().Utf8Value() : "wasapi";
  std::string err;
  Ctx* c = contextFor(backend, &err);
  if (!c) { Napi::Error::New(env, err).ThrowAsJavaScriptException(); return env.Undefined(); }
  ma_device_info* pb = nullptr; ma_uint32 nPb = 0;
  ma_device_info* cp = nullptr; ma_uint32 nCp = 0;
  ma_result r = ma_context_get_devices(&c->ctx, &pb, &nPb, &cp, &nCp);
  if (r != MA_SUCCESS) { Napi::Error::New(env, std::string("ma_context_get_devices: ") + ma_result_description(r)).ThrowAsJavaScriptException(); return env.Undefined(); }
  Napi::Object out = Napi::Object::New(env);
  auto fill = [&](ma_device_info* list, ma_uint32 n, ma_device_type type) {
    Napi::Array arr = Napi::Array::New(env);
    for (ma_uint32 i = 0; i < n; i++) {
      ma_device_info full{};
      if (ma_context_get_device_info(&c->ctx, type, &list[i].id, &full) != MA_SUCCESS) full = list[i];
      full.isDefault = list[i].isDefault;
      arr.Set(i, deviceInfoToJs(env, c->backend, type, full));
    }
    return arr;
  };
  out.Set("playback", fill(pb, nPb, ma_device_type_playback));
  out.Set("capture", fill(cp, nCp, ma_device_type_capture));
  out.Set("backend", ma_get_backend_name(c->backend));
  return out;
}

std::vector<unsigned> numberArray(Napi::Value v, const std::vector<unsigned>& def) {
  if (!v.IsArray()) return def;
  Napi::Array a = v.As<Napi::Array>();
  std::vector<unsigned> out;
  for (uint32_t i = 0; i < a.Length(); i++) if (a.Get(i).IsNumber()) out.push_back(a.Get(i).As<Napi::Number>().Uint32Value());
  return out.empty() ? def : out;
}

// probeExclusive(deviceId, kind, {rates?, channels?}) → [{rate,bits,validBits,channels,isFloat}]
Napi::Value ProbeExclusive(const Napi::CallbackInfo& ci) {
  Napi::Env env = ci.Env();
  std::string id = ci.Length() >= 1 && ci[0].IsString() ? ci[0].As<Napi::String>().Utf8Value() : "";
  bool capture = !(ci.Length() >= 2 && ci[1].IsString() && ci[1].As<Napi::String>().Utf8Value() == "playback");
  Napi::Object o = ci.Length() >= 3 && ci[2].IsObject() ? ci[2].As<Napi::Object>() : Napi::Object::New(env);
  auto rates = numberArray(o.Get("rates"), {44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000});
  auto chs = numberArray(o.Get("channels"), {1, 2});
  auto res = jw::probeExclusiveFormats(widen(id), capture, rates, chs);
  Napi::Array arr = Napi::Array::New(env);
  for (size_t i = 0; i < res.size(); i++) {
    Napi::Object f = Napi::Object::New(env);
    f.Set("rate", res[i].rate); f.Set("bits", res[i].bits); f.Set("validBits", res[i].validBits);
    f.Set("channels", res[i].channels); f.Set("isFloat", res[i].isFloat);
    arr.Set(static_cast<uint32_t>(i), f);
  }
  return arr;
}

Napi::Value Sessions(const Napi::CallbackInfo& ci) {
  Napi::Env env = ci.Env();
  std::string id = ci.Length() >= 1 && ci[0].IsString() ? ci[0].As<Napi::String>().Utf8Value() : "";
  bool capture = !(ci.Length() >= 2 && ci[1].IsString() && ci[1].As<Napi::String>().Utf8Value() == "playback");
  auto res = jw::sessionsOf(widen(id), capture);
  Napi::Array arr = Napi::Array::New(env);
  for (size_t i = 0; i < res.size(); i++) {
    Napi::Object s = Napi::Object::New(env);
    s.Set("pid", res[i].pid); s.Set("process", res[i].process); s.Set("state", res[i].state); s.Set("systemSounds", res[i].isSystemSounds);
    arr.Set(static_cast<uint32_t>(i), s);
  }
  return arr;
}

Napi::Value DeviceFormat(const Napi::CallbackInfo& ci) {
  Napi::Env env = ci.Env();
  std::string id = ci.Length() >= 1 && ci[0].IsString() ? ci[0].As<Napi::String>().Utf8Value() : "";
  bool capture = !(ci.Length() >= 2 && ci[1].IsString() && ci[1].As<Napi::String>().Utf8Value() == "playback");
  auto f = jw::deviceFormat(widen(id), capture);
  Napi::Object o = Napi::Object::New(env);
  o.Set("ok", f.ok); o.Set("rate", f.rate); o.Set("bits", f.bits); o.Set("validBits", f.validBits); o.Set("channels", f.channels); o.Set("isFloat", f.isFloat);
  o.Set("defaultPeriodUs", Napi::Number::New(env, static_cast<double>(f.defaultPeriod) / 10.0));
  o.Set("minimumPeriodUs", Napi::Number::New(env, static_cast<double>(f.minimumPeriod) / 10.0));
  return o;
}

Napi::Value LastWasapiHr(const Napi::CallbackInfo& ci) {
  long hr = ma_jw_wasapi_last_hr();
  Napi::Object o = Napi::Object::New(ci.Env());
  o.Set("hr", Napi::Number::New(ci.Env(), static_cast<double>(static_cast<unsigned long>(hr))));
  o.Set("code", jw::hresultCode(hr));
  return o;
}

Napi::Value Version(const Napi::CallbackInfo& ci) {
  Napi::Object o = Napi::Object::New(ci.Env());
  o.Set("miniaudio", ma_version_string());
  o.Set("napi", NAPI_VERSION);
  o.Set("addon", "0.1.0");
  return o;
}

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("Device", Device::Init(env));
  exports.Set("Resampler", Resampler::Init(env));
  exports.Set("RingTest", RingTest::Init(env));
  exports.Set("listDevices", Napi::Function::New(env, ListDevices));
  exports.Set("probeExclusive", Napi::Function::New(env, ProbeExclusive));
  exports.Set("sessions", Napi::Function::New(env, Sessions));
  exports.Set("deviceFormat", Napi::Function::New(env, DeviceFormat));
  exports.Set("lastWasapiHr", Napi::Function::New(env, LastWasapiHr));
  exports.Set("version", Napi::Function::New(env, Version));
  return exports;
}

}  // namespace

NODE_API_MODULE(jw_native_audio, InitModule)
