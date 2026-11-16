/**
 * 원격 화면 화질 모드 — 뷰어가 선택하고(데이터 채널 {t:'q'}), 러너가 연결을 유지한 채 인코더 설정만 변경한다.
 *
 *  auto   회선 상태에 위임 — 상한 12 Mbps · 30 fps · 균형(balanced) · 글자 우선 힌트
 *  sharp  선명하게 — 상한 20 Mbps · 30 fps · 해상도 유지(프레임을 양보) · 텍스트 힌트. 문서·코드·설정 화면
 *  smooth 부드럽게 — 상한 20 Mbps · 60 fps · 프레임 유지(해상도를 양보) · 움직임 힌트. 영상·스크롤
 *
 * 뷰어 창이 원본보다 작으면(auto·smooth) 해당 크기로 축소하여 송신한다 — 4K 화면을 작은 창으로 볼 때의 대역 낭비를 제거한다.
 * sharp 는 축소하지 않는다(뷰어가 확대하여 볼 수 있도록). 뷰어가 '실제 크기'로 보면 vw·vh 를 0 으로 송신하여 축소하지 않는다.
 */
export type QualityMode = 'auto' | 'sharp' | 'smooth';
export const QUALITY_MODES: readonly QualityMode[] = ['auto', 'sharp', 'smooth'];

export interface QualityParams {
  mode: QualityMode;
  maxBitrate: number;
  fps: number;
  degradation: 'balanced' | 'maintain-resolution' | 'maintain-framerate';
  hint: 'detail' | 'text' | 'motion';
  /** 1 = 원본. 2 = 가로세로 절반 */
  scale: number;
}

const BASE: Record<QualityMode, Omit<QualityParams, 'scale' | 'mode'>> = {
  auto: { maxBitrate: 12_000_000, fps: 30, degradation: 'balanced', hint: 'detail' },
  sharp: { maxBitrate: 20_000_000, fps: 30, degradation: 'maintain-resolution', hint: 'text' },
  smooth: { maxBitrate: 20_000_000, fps: 60, degradation: 'maintain-framerate', hint: 'motion' },
};

/** 원본(capture) 이 뷰어 창(view, 물리 픽셀)보다 클 때 축소하는 배율. 0·없음이면 1. 4 배를 초과하여 축소하지 않는다. */
export function downscale(capture: { w: number; h: number }, view: { w: number; h: number } | null): number {
  if (!view || view.w <= 0 || view.h <= 0 || capture.w <= 0 || capture.h <= 0) return 1;
  const s = Math.max(capture.w / view.w, capture.h / view.h);
  return s <= 1.05 ? 1 : Math.min(4, Math.round(s * 100) / 100);
}

export function qualityParams(mode: QualityMode, capture: { w: number; h: number }, view: { w: number; h: number } | null): QualityParams {
  return { mode, ...BASE[mode], scale: mode === 'sharp' ? 1 : downscale(capture, view) };
}
