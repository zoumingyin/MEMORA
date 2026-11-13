import { useThemeStore } from '../store/useThemeStore'

interface BrandLogoProps {
  /** 高度（px）；宽度按 560:150 原始比例自动换算，不拉伸 */
  height?: number
  className?: string
}

/** 横向完整 Logo（图形 + MEMORA + 口号），浅色/深色自动换版，保持原始比例 */
export function BrandLogo({ height = 32, className }: BrandLogoProps) {
  const dark = useThemeStore((state) => state.resolvedTheme) === 'dark'
  return (
    <img
      src={dark ? '/brand/memora-logo-dark.svg' : '/brand/memora-logo.svg'}
      alt="MEMORA — Think · Note · Do"
      height={height}
      width={Math.round((height * 560) / 150)}
      className={className}
      draggable={false}
    />
  )
}

interface BrandMarkProps {
  size?: number
  className?: string
}

/** 独立品牌标记（无文字），用于标题栏等小尺寸位置 */
export function BrandMark({ size = 18, className }: BrandMarkProps) {
  return (
    <img
      src="/brand/memora-mark.svg"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={className}
      draggable={false}
    />
  )
}