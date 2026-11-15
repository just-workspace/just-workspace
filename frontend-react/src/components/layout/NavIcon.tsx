/**
 * 사이드바 rail용 아이콘. 모듈 registry의 icon 이름(lucide식) → SVG path.
 * 아이콘 표는 공용 세트(utils/icons.ts)를 그대로 쓴다 — UiIcon 과 같은 그림.
 */
import { iconPaths } from '~/utils/icons'

export interface LayoutNavIconProps {
  /** utils/icons 이름. 없으면 dot */
  name?: string
  className?: string
}

export function LayoutNavIcon({ name, className }: LayoutNavIconProps) {
  return (
    <svg
      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: iconPaths(name) }}
    />
  )
}

export default LayoutNavIcon
