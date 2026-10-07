import { HttpError } from '@/lib/server/http';

type ClockRule = { weekdays: number[]; startTime: string; endTime: string; timezone: string; enabled: boolean };
function clockMinutes(value: string) { const [hours, minutes] = value.split(':').map(Number); return hours * 60 + minutes; }
function expand(rule: ClockRule) {
  const result = new Map<number, Array<[number, number]>>();
  const add = (day: number, start: number, end: number) => result.set(day, [...(result.get(day) ?? []), [start, end]]);
  const start = clockMinutes(rule.startTime);
  const end = clockMinutes(rule.endTime);
  for (const day of rule.weekdays) {
    if (start < end) add(day, start, end);
    else {
      add(day, start, 1440);
      add(day === 7 ? 1 : day + 1, 0, end);
    }
  }
  return result;
}
export function assertNoOverlap(candidate: ClockRule, existing: ClockRule[]) {
  if (!candidate.enabled) return;
  const a = expand(candidate);
  for (const other of existing) {
    if (!other.enabled || other.timezone !== candidate.timezone) continue;
    const b = expand(other);
    for (const [day, intervals] of a) {
      const matches = b.get(day) ?? [];
      for (const [aStart, aEnd] of intervals) for (const [bStart, bEnd] of matches) {
        if (aStart < bEnd && bStart < aEnd) throw new HttpError(409, 'يوجد تداخل زمني مع جدول آخر لهذه الشاشة في المنطقة الزمنية نفسها.', 'schedule_overlap');
      }
    }
  }
}
