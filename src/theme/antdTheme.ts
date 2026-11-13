import { theme as antdTheme, type ThemeConfig } from 'antd'
import { memoraDarkTheme, memoraTheme } from './memora-theme'
import type { ResolvedTheme } from './themeBridge'

/**
 * 控件保持紧凑尺寸：主窗口最小 422×540、标题栏 40px，
 * 品牌资源包默认的 controlHeight 36 / fontSize 14 会撑破既有布局。
 * 圆角、配色、字体族全部采用品牌规范，度量沿用应用现状。
 */
const COMPACT = {
  borderRadius: 10,
  borderRadiusLG: 16,
  borderRadiusSM: 6,
  controlHeight: 30,
  controlHeightLG: 36,
  controlHeightSM: 24,
  fontSize: 13,
  lineHeight: 1.55,
} as const

/** MEMORA antd 主题：品牌 token + 深色算法 + 逐组件可读性修正 */
export function buildAntdTheme(resolved: ResolvedTheme): ThemeConfig {
  const dark = resolved === 'dark'
  const base = dark ? memoraDarkTheme : memoraTheme
  const primary = dark ? '#8292FF' : '#536DFF'
  const soft = dark ? '#263252' : '#EEF1FF'
  const border = dark ? '#2D3B54' : '#E5EAF3'
  const controlBorder = dark ? '#3B4C6B' : '#D3DBE8'
  const text = dark ? '#E8EDFA' : '#14213D'
  const textSecondary = dark ? '#A8B4CC' : '#64748B'
  const textTertiary = dark ? '#7F8CA6' : '#94A3B8'
  // 弹层一律不透明实底：半透明会透出底层卡片文字，深色下尤其明显
  const elevated = dark ? '#202C42' : '#FFFFFF'
  const hoverFill = dark ? 'rgba(232, 237, 250, 0.08)' : 'rgba(20, 33, 61, 0.05)'

  return {
    ...base,
    algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      ...base.token,
      ...COMPACT,
      colorPrimary: primary,
      colorInfo: dark ? '#72A0FF' : '#397BFF',
      colorLink: primary,
      colorLinkHover: dark ? '#9BA7FF' : '#4357E8',
      colorText: text,
      colorTextSecondary: textSecondary,
      colorTextTertiary: textTertiary,
      colorTextPlaceholder: textTertiary,
      colorBorder: border,
      colorBorderSecondary: dark ? '#26334A' : '#EEF1F7',
      colorBgElevated: elevated,
      colorBgContainer: dark ? '#182235' : '#FFFFFF',
      colorBgLayout: dark ? '#111827' : '#F8FAFC',
      colorFillTertiary: hoverFill,
      colorFillQuaternary: dark ? 'rgba(232, 237, 250, 0.04)' : 'rgba(20, 33, 61, 0.03)',
      // 聚焦改为细环而非大面积光晕，避免紧凑窗口里控件互相盖住
      controlOutline: dark ? 'rgba(130, 146, 255, 0.18)' : 'rgba(83, 109, 255, 0.14)',
      controlOutlineWidth: 2,
    },
    components: {
      ...base.components,
      Button: {
        ...base.components?.Button,
        borderRadius: 10,
        controlHeight: 30,
        fontWeight: 500,
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
      },
      Input: {
        ...base.components?.Input,
        borderRadius: 10,
        activeBorderColor: primary,
        hoverBorderColor: controlBorder,
        activeShadow: '0 0 0 2px rgba(83, 109, 255, 0.14)',
        colorBgContainer: dark ? '#202C42' : '#FFFFFF',
      },
      InputNumber: {
        borderRadius: 10,
        activeBorderColor: primary,
        hoverBorderColor: controlBorder,
        colorBgContainer: dark ? '#202C42' : '#FFFFFF',
      },
      Select: {
        ...base.components?.Select,
        borderRadius: 10,
        borderRadiusLG: 12,
        optionSelectedBg: soft,
        optionSelectedColor: dark ? '#E8EDFA' : '#4357E8',
        optionActiveBg: hoverFill,
        colorBgContainer: dark ? '#202C42' : '#FFFFFF',
        colorBgElevated: elevated,
      },
      DatePicker: {
        borderRadius: 10,
        activeBorderColor: primary,
        hoverBorderColor: controlBorder,
        colorBgContainer: dark ? '#202C42' : '#FFFFFF',
        colorBgElevated: elevated,
        cellActiveWithRangeBg: soft,
      },
      // Dropdown / Menu 弹层：深色下选中项用浅底+亮字，避免蓝字压深蓝底
      Menu: {
        ...base.components?.Menu,
        itemBorderRadius: 8,
        itemColor: text,
        itemSelectedColor: dark ? '#E8EDFA' : '#4357E8',
        itemSelectedBg: soft,
        itemActiveBg: hoverFill,
        groupTitleColor: textSecondary,
        popupBg: elevated,
        subMenuItemBg: elevated,
      },
      Dropdown: { colorBgElevated: elevated, borderRadiusLG: 12 },
      Popover: { colorBgElevated: elevated, borderRadiusLG: 12 },
      Tooltip: {
        colorBgSpotlight: dark ? '#2D3B54' : '#14213D',
        colorTextLightSolid: '#F8FAFC',
        borderRadius: 8,
      },
      Card: {
        ...base.components?.Card,
        borderRadiusLG: 12,
        paddingLG: 16,
        colorBgContainer: dark ? '#182235' : '#FFFFFF',
        colorBorderSecondary: border,
      },
      Modal: {
        ...base.components?.Modal,
        borderRadiusLG: 16,
        titleFontSize: 15,
        contentBg: dark ? '#182235' : '#FFFFFF',
        headerBg: dark ? '#182235' : '#FFFFFF',
        footerBg: dark ? '#182235' : '#FFFFFF',
      },
      Drawer: {
        borderRadiusLG: 16,
        colorBgElevated: dark ? '#182235' : '#FFFFFF',
        colorBgMask: dark ? 'rgba(8, 12, 22, 0.6)' : 'rgba(20, 33, 61, 0.32)',
      },
      Tabs: {
        ...base.components?.Tabs,
        itemSelectedColor: primary,
        itemHoverColor: dark ? '#9BA7FF' : '#4357E8',
        inkBarColor: primary,
        itemColor: textSecondary,
      },
      Table: {
        borderRadius: 12,
        headerBg: dark ? '#202C42' : '#F8FAFC',
        headerColor: textSecondary,
        rowHoverBg: hoverFill,
        colorBgContainer: dark ? '#182235' : '#FFFFFF',
        borderColor: border,
      },
      Notification: { colorBgElevated: elevated, borderRadiusLG: 12 },
      Message: { contentBg: elevated, borderRadiusLG: 10 },
      Switch: { ...base.components?.Switch, colorPrimary: primary },
      Slider: {
        railBg: dark ? '#2D3B54' : '#E5EAF3',
        railHoverBg: dark ? '#3B4C6B' : '#D3DBE8',
        trackBg: primary,
        trackHoverBg: dark ? '#9BA7FF' : '#4357E8',
        handleColor: primary,
      },
      Tag: { ...base.components?.Tag, borderRadiusSM: 6 },
      Segmented: {
        borderRadius: 10,
        itemSelectedBg: dark ? '#2D3B54' : '#FFFFFF',
        itemSelectedColor: text,
        trackBg: dark ? '#182235' : '#F1F5F9',
      },
      Empty: { colorTextDisabled: textTertiary },
      Alert: { borderRadiusLG: 10 },
    },
  }
}