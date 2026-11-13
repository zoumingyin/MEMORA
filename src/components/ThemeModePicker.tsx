import { useThemeStore } from '../store/useThemeStore'
import type { ThemeMode } from '../theme/themeBridge'

const OPTIONS: Array<{ mode: ThemeMode; label: string; hint: string }> = [
  { mode: 'light', label: '浅色', hint: '始终使用浅色外观' },
  { mode: 'dark', label: '深色', hint: '始终使用深色外观' },
  { mode: 'system', label: '跟随系统', hint: '随 Windows 应用模式自动切换' },
]

/** 迷你外观预览：纯装饰，色值取自品牌浅色 / 深色规范 */
function Preview({ mode }: { mode: ThemeMode }) {
  const half = (dark: boolean) => (
    <span
      className="flex h-full flex-1 flex-col gap-[3px] p-[6px]"
      style={{ background: dark ? '#111827' : '#F8FAFC' }}
    >
      <span
        className="h-[6px] w-[60%] rounded-[2px]"
        style={{ background: dark ? '#8292FF' : '#536DFF' }}
      />
      <span
        className="h-[4px] w-full rounded-[2px]"
        style={{ background: dark ? '#202C42' : '#FFFFFF' }}
      />
      <span
        className="h-[4px] w-[75%] rounded-[2px]"
        style={{ background: dark ? '#202C42' : '#FFFFFF' }}
      />
      <span
        className="mt-auto h-[4px] w-[40%] rounded-[2px]"
        style={{ background: '#08C6C8' }}
      />
    </span>
  )
  return (
    <span
      className="flex h-[52px] w-full overflow-hidden rounded-[8px]"
      style={{ border: '1px solid var(--memora-border)' }}
      aria-hidden="true"
    >
      {mode === 'system' ? (
        <>
          {half(false)}
          {half(true)}
        </>
      ) : (
        half(mode === 'dark')
      )}
    </span>
  )
}

/** 外观设置 → 主题模式：三档单选，切换即时生效并广播到全部窗口 */
export function ThemeModePicker() {
  const mode = useThemeStore((state) => state.mode)
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme)
  const setMode = useThemeStore((state) => state.setMode)

  return (
    <div
      className="grid grid-cols-3 gap-2"
      role="radiogroup"
      aria-label="主题模式"
      data-tauri-drag-region="false"
    >
      {OPTIONS.map((option) => {
        const active = mode === option.mode
        return (
          <button
            key={option.mode}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.hint}
            onClick={() => setMode(option.mode)}
            className={`flex cursor-pointer flex-col gap-2 rounded-[12px] border p-2 text-left transition-colors duration-150 ${
              active
                ? 'border-[var(--memora-primary)] bg-[var(--memora-primary-soft)]'
                : 'border-[var(--memora-border)] bg-[var(--memora-surface)] hover:border-[var(--memora-primary)]'
            }`}
          >
            <Preview mode={option.mode} />
            <span className="flex items-center justify-between gap-1">
              <span
                className={`text-[12px] ${
                  active
                    ? 'font-600 text-[var(--memora-primary)]'
                    : 'text-[var(--memora-text)]'
                }`}
              >
                {option.label}
              </span>
              <span
                aria-hidden="true"
                className={`h-[12px] w-[12px] shrink-0 rounded-full border-[3px] ${
                  active
                    ? 'border-[var(--memora-primary)] bg-transparent'
                    : 'border-[var(--memora-border)] bg-transparent'
                }`}
              />
            </span>
          </button>
        )
      })}
      <span className="col-span-3 text-[11px] text-[var(--memora-text-secondary)]">
        {mode === 'system'
          ? `跟随 Windows 应用模式，当前为${resolvedTheme === 'dark' ? '深色' : '浅色'}`
          : OPTIONS.find((option) => option.mode === mode)?.hint}
      </span>
    </div>
  )
}