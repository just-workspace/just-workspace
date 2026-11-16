/*
 * speexdsp 리샘플러(BSD-3-Clause) 단독 빌드. 수신 스트림 레이트 != 재생 장치 레이트일 때만 사용한다(비트퍼펙트 아님으로 표시).
 * OUTSIDE_SPEEX / RANDOM_PREFIX / FLOATING_POINT 는 binding.gyp defines 에 정의.
 */
#include "../vendor/speexdsp/resample.c"
