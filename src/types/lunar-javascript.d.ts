/** lunar-javascript 最小类型声明（仅声明用到的 API） */
declare module 'lunar-javascript' {
  export class Solar {
    getYear(): number
    getMonth(): number
    getDay(): number
    /** 公历节日（如 元旦、劳动节），无节日返回空数组 */
    getFestivals(): string[]
  }

  export class Lunar {
    /** 从公历日期推算农历 */
    static fromDate(date: Date): Lunar
    /** 按农历年月日构建（用于换算次年同一农历日期） */
    static fromYmd(year: number, month: number, day: number): Lunar
    /** 农历年（数字，含正负干支纪年偏移） */
    getYear(): number
    /** 农历月（1-12，闰月为负数） */
    getMonth(): number
    /** 农历日（1-30） */
    getDay(): number
    /** 换算为对应公历 */
    getSolar(): Solar
    /** 农历日中文名（初一、初二 … 三十） */
    getDayInChinese(): string
    /** 农历月中文名（正、二 … 十一、十二，不含「月」字与「闰」前缀） */
    getMonthInChinese(): string
    /** 当天节气名（如 清明、冬至），非节气日返回空字符串 */
    getJieQi(): string
    /** 农历节日（如 春节、中秋节），无节日返回空数组 */
    getFestivals(): string[]
  }
}
