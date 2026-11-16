import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// 앱 토큰 유틸 중 이름만으로는 종류를 식별할 수 없는 항목 — bg-cat-hatch 는 배경색이 아니라 무늬(background-image)이므로
// bg-primary 같은 배경색과 함께 사용해도 상호 제거되지 않도록 한다.
const twMerge = extendTailwindMerge({ extend: { classGroups: { 'bg-image': [{ bg: ['cat-hatch'] }] } } })

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
