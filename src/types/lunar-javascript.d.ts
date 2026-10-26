/** lunar-javascript 最小类型声明（仅声明用到的 API） */
declare module 'lunar-javascript' {
  export class Solar {
    getYear(): number
    getMonth(): number
    getDay(): number
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
    /** 农历日 */
    getDay(): number
    /** 换算为对应公历 */
    getSolar(): Solar
  }
}
