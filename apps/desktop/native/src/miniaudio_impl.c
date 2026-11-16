/*
 * miniaudio 구현 번역 단위(C). 필요한 기능만 활성화한다 — 장치 I/O(WASAPI + null 백엔드) 와 포맷 변환.
 * 디코더·인코더·엔진·리소스 매니저·노드 그래프는 제외하여 컴파일 시간과 바이너리 크기를 줄인다.
 * vendor/miniaudio/miniaudio.h 는 0.11.25 + apply-patch.py(JW_PATCH_R19) 적용본.
 */
#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_DECODING
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_ENGINE
#define MA_NO_NODE_GRAPH
#define MA_NO_RESOURCE_MANAGER
#define MA_NO_RUNTIME_LINKING_FOR_NON_WIN32
#define MA_ENABLE_ONLY_SPECIFIC_BACKENDS
#define MA_ENABLE_WASAPI
#define MA_ENABLE_NULL
#include "miniaudio.h"
