/**
 * 표 — 열 정의(columns)와 행(rows)을 받아 렌더링하는 읽기 전용 표. 정렬·선택은 미지원.
 * 좁은 화면에서는 표만 가로 스크롤된다(페이지는 스크롤되지 않는다). 스크롤 영역은 키보드로도 접근 가능하도록 tabIndex=0 + 이름을 지정한다.
 * 머리글은 <th scope="col">, 숫자·주소·포트 열은 mono.
 */
import type { HTMLAttributes, Key, ReactNode } from 'react'
import { cn } from '~/lib/utils'

export interface UiTableColumn<T> {
  /** 열 식별자(React key) */
  key: string
  /** 머리글 */
  header: ReactNode
  /** 칸 내용 */
  cell: (row: T, index: number) => ReactNode
  /** 숫자·주소·포트 등 mono 적용 */
  mono?: boolean
  /** 칸에 추가할 클래스(너비·줄바꿈 등) */
  className?: string
}

export interface UiTableProps<T> extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** 열 정의(필수) */
  columns: UiTableColumn<T>[]
  /** 행(필수) */
  rows: T[]
  /** 행 key */
  rowKey: (row: T, index: number) => Key
  /** 표 이름(화면 낭독기용 caption + 스크롤 영역의 이름, 필수) */
  label: string
  /** 표의 최소 너비 클래스(기본 min-w-[480px]) — 이보다 좁으면 가로 스크롤 */
  minWidthClass?: string
  /** 행이 없을 때 표시할 내용 */
  empty?: ReactNode
}

/**
 * 표.
 * @example <UiTable label="열 포트" rowKey={r => r.port} rows={rows} columns={[{ key: 'port', header: '포트', mono: true, cell: r => r.port }]} />
 */
export function UiTable<T>({ columns, rows, rowKey, label, minWidthClass = 'min-w-[480px]', empty, className, ...rest }: UiTableProps<T>) {
  return (
    <div {...rest} role="region" aria-label={label} tabIndex={0} className={cn('overflow-x-auto focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', className ?? '')}>
      <table className={cn('w-full border-collapse text-left text-[13px] leading-5', minWidthClass)}>
        <caption className="sr-only">{label}</caption>
        <thead>
          <tr>
            {columns.map(c => (
              <th key={c.key} scope="col" className="whitespace-nowrap border-t border-border px-4 py-2 text-xs font-semibold text-muted-foreground">{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={rowKey(row, i)}>
              {columns.map(c => (
                <td key={c.key} className={cn('border-t border-border px-4 py-2 align-top', c.mono && 'font-mono text-xs', c.className ?? '')}>{c.cell(row, i)}</td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && empty != null && (
            <tr><td colSpan={columns.length} className="border-t border-border px-4 py-6 text-center text-muted-foreground">{empty}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

export default UiTable
