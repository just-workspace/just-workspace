#!/usr/bin/env python3
"""
miniaudio 0.11.25 에 r19/hires 패치를 적용한다(멱등). 원본은 public domain / MIT-0 라 수정·재배포 자유.

패치 1 — WASAPI exclusive 포맷 선택: 원본은 exclusive 모드에서 항상 Windows "기본 형식"(PKEY_AudioEngine_DeviceFormat)을 쓴다.
          우리는 호출자가 요청한 포맷(예 24/96, 32/192)을 먼저 IsFormatSupported(EXCLUSIVE) 로 시험하고, 되면 그걸 쓴다.
          24-bit 는 packed 24 → 24-in-32 컨테이너 순으로 시험한다(후자는 s32 로 들어오고 미니오디오가 >>8 로 정확히 s24 로 바꾼다).
패치 2 — exclusive 실패 HRESULT 보존: AUDCLNT_E_DEVICE_IN_USE / EXCLUSIVE_MODE_NOT_ALLOWED / UNSUPPORTED_FORMAT 를
          구분해 사용자에게 이유를 보여 주기 위해 마지막 HRESULT 를 ma_jw_wasapi_last_hr() 로 꺼낸다.

사용: python apply-patch.py  (같은 디렉터리의 miniaudio.h 를 제자리 수정)
"""
import pathlib
import sys

p = pathlib.Path(__file__).with_name('miniaudio.h')
src = p.read_text(encoding='utf-8')
if 'JW_PATCH_R19' in src:
    print('already patched')
    sys.exit(0)

# ── 패치 2a: 전역 + 접근자 ──
anchor_fn = 'static ma_result ma_device_init_internal__wasapi(ma_context* pContext, ma_device_type deviceType, const ma_device_id* pDeviceID, ma_device_init_internal_data__wasapi* pData)\n{'
assert src.count(anchor_fn) == 1, 'init fn anchor'
src = src.replace(anchor_fn, '''/* JW_PATCH_R19: last WASAPI HRESULT of a failed exclusive-mode attempt (0 = none). */
static volatile long g_jwWasapiLastHR = 0;
MA_API long ma_jw_wasapi_last_hr(void) { return g_jwWasapiLastHR; }
MA_API void ma_jw_wasapi_reset_last_hr(void) { g_jwWasapiLastHR = 0; }

''' + anchor_fn)

# ── 패치 1: 요청 포맷 우선 시험 ──
old = '''    if (pData->shareMode == ma_share_mode_exclusive) {
    #if defined(MA_WIN32_DESKTOP) || defined(MA_WIN32_GDK)
        /* In exclusive mode on desktop we always use the backend's native format. */
        ma_IPropertyStore* pStore = NULL;
        hr = ma_IMMDevice_OpenPropertyStore(pDeviceInterface, STGM_READ, &pStore);
        if (SUCCEEDED(hr)) {'''
new = '''    if (pData->shareMode == ma_share_mode_exclusive) {
    #if defined(MA_WIN32_DESKTOP) || defined(MA_WIN32_GDK)
        ma_IPropertyStore* pStore = NULL;
        /* JW_PATCH_R19: try the caller's requested format first (24/96, 32/192 ...) instead of only the Windows default format. */
        ma_bool32 jwUseRequested = MA_FALSE;
        hr = S_FALSE;
        if (pData->formatIn != ma_format_unknown && pData->channelsIn != 0 && pData->sampleRateIn != 0) {
            MA_WAVEFORMATEXTENSIBLE wfReq;
            ma_channel jwChMap[MA_MAX_CHANNELS];
            ma_uint32 jwAttempt;
            ma_uint32 jwAttempts = (pData->formatIn == ma_format_s24) ? 2 : 1;
            for (jwAttempt = 0; jwAttempt < jwAttempts && hr != S_OK; jwAttempt += 1) {
                MA_ZERO_OBJECT(&wfReq);
                ma_channel_map_init_standard(ma_standard_channel_map_microsoft, jwChMap, ma_countof(jwChMap), pData->channelsIn);
                wfReq.wFormatTag     = WAVE_FORMAT_EXTENSIBLE;
                wfReq.nChannels      = (WORD)pData->channelsIn;
                wfReq.nSamplesPerSec = pData->sampleRateIn;
                wfReq.cbSize         = 22; /* sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX) */
                wfReq.dwChannelMask  = ma_channel_map_to_channel_mask__win32(jwChMap, pData->channelsIn);
                if (pData->formatIn == ma_format_f32) {
                    wfReq.wBitsPerSample = 32;
                    wfReq.Samples.wValidBitsPerSample = 32;
                    wfReq.SubFormat = MA_GUID_KSDATAFORMAT_SUBTYPE_IEEE_FLOAT;
                } else {
                    wfReq.SubFormat = MA_GUID_KSDATAFORMAT_SUBTYPE_PCM;
                    wfReq.wBitsPerSample = (WORD)(ma_get_bytes_per_sample(pData->formatIn) * 8);
                    wfReq.Samples.wValidBitsPerSample = wfReq.wBitsPerSample;
                    if (pData->formatIn == ma_format_s24 && jwAttempt == 1) {
                        wfReq.wBitsPerSample = 32;               /* 24-in-32 container */
                        wfReq.Samples.wValidBitsPerSample = 24;
                    }
                }
                wfReq.nBlockAlign     = (WORD)(wfReq.nChannels * wfReq.wBitsPerSample / 8);
                wfReq.nAvgBytesPerSec = wfReq.nBlockAlign * wfReq.nSamplesPerSec;
                hr = ma_IAudioClient_IsFormatSupported((ma_IAudioClient*)pData->pAudioClient, MA_AUDCLNT_SHAREMODE_EXCLUSIVE, (MA_WAVEFORMATEX*)&wfReq, NULL);
                if (hr == S_OK) {
                    MA_COPY_MEMORY(&wf, &wfReq, sizeof(MA_WAVEFORMATEXTENSIBLE));
                    jwUseRequested = MA_TRUE;
                } else {
                    g_jwWasapiLastHR = (long)hr;
                }
            }
        }
        if (!jwUseRequested) {
        hr = ma_IMMDevice_OpenPropertyStore(pDeviceInterface, STGM_READ, &pStore);
        if (SUCCEEDED(hr)) {'''
assert src.count(old) == 1, 'exclusive block anchor'
src = src.replace(old, new)

# 원본 블록 `if (SUCCEEDED(hr)) { ... ma_IPropertyStore_Release(pStore); }` 뒤에 `if (!jwUseRequested)` 의 닫는 괄호를 넣는다.
old_close = '''            ma_IPropertyStore_Release(pStore);
        }
    #else
        /*
        I do not know how to query the device's native format on UWP'''
assert src.count(old_close) == 1, 'close anchor'
src = src.replace(old_close, '''            ma_IPropertyStore_Release(pStore);
        }
        } /* JW_PATCH_R19: !jwUseRequested */
    #else
        /*
        I do not know how to query the device's native format on UWP''')

# ── 패치 2b: exclusive Initialize 실패 HRESULT 보존 ──
old2 = '''        if (FAILED(hr)) {
            /* Failed to initialize in exclusive mode. Don't fall back to shared mode - instead tell the client about it. They can reinitialize in shared mode if they want. */
            if (hr == E_ACCESSDENIED) {'''
new2 = '''        if (FAILED(hr)) {
            g_jwWasapiLastHR = (long)hr; /* JW_PATCH_R19 */
            /* Failed to initialize in exclusive mode. Don't fall back to shared mode - instead tell the client about it. They can reinitialize in shared mode if they want. */
            if (hr == E_ACCESSDENIED) {'''
assert src.count(old2) == 1, 'init failure anchor'
src = src.replace(old2, new2)

# ── 패치 2c: 포맷을 못 찾아 MA_SHARE_MODE_NOT_SUPPORTED 로 나가는 자리 ──
old3 = '''        if (hr == S_OK) {
            shareMode = MA_AUDCLNT_SHAREMODE_EXCLUSIVE;
            result = MA_SUCCESS;
        } else {
            result = MA_SHARE_MODE_NOT_SUPPORTED;
        }'''
new3 = '''        if (hr == S_OK) {
            shareMode = MA_AUDCLNT_SHAREMODE_EXCLUSIVE;
            result = MA_SUCCESS;
        } else {
            if (hr != S_FALSE) { g_jwWasapiLastHR = (long)hr; } /* JW_PATCH_R19 */
            result = MA_SHARE_MODE_NOT_SUPPORTED;
        }'''
assert src.count(old3) == 1, 'share mode result anchor'
src = src.replace(old3, new3)

p.write_text(src, encoding='utf-8')
print('patched')
