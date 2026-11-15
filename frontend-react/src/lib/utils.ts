import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// 앱 토큰 유틸 중 이름만으로는 종류를 못 알아보는 것 — bg-cat-hatch 는 바탕색이 아니라 무늬(background-image)라
// bg-primary 같은 바탕색과 같이 써도 서로 지우지 않게 한다.
const twMerge = extendTailwindMerge({ extend: { classGroups: { 'bg-image': [{ bg: ['cat-hatch'] }] } } })

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
