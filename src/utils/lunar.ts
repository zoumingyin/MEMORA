import dayjs, { type Dayjs } from "dayjs";
import { Lunar } from "lunar-javascript";

/** 可接受的日期输入：Dayjs / Date / 毫秒时间戳 */
type DateLike = Dayjs | Date | number;

function toLunar(date: DateLike): Lunar {
  return Lunar.fromDate(dayjs(date).toDate());
}

/** 农历月日短描述：闰X月X日（闰月带「闰」前缀），用于农历模式说明与日期面板小字 */
export function lunarMonthDay(date: DateLike): string {
  const lunar = toLunar(date);
  return `${lunar.getMonth() < 0 ? "闰" : ""}${lunar.getMonthInChinese()}月${lunar.getDayInChinese()}`;
}

/** 日历格农历小字：节气 > 节日（农历 / 公历） > 初一显月名 > 农历日 */
export function lunarText(date: DateLike): string {
  const lunar = toLunar(date);
  const jieqi = lunar.getJieQi();
  if (jieqi) return jieqi;
  const lunarFest = lunar.getFestivals();
  if (lunarFest.length > 0) return lunarFest[0];
  const solarFest = lunar.getSolar().getFestivals();
  if (solarFest.length > 0) return solarFest[0];
  if (lunar.getDay() === 1) {
    return `${lunar.getMonth() < 0 ? "闰" : ""}${lunar.getMonthInChinese()}月`;
  }
  return lunar.getDayInChinese();
}

