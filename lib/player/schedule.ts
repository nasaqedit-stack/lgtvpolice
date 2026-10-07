import type { ScreenManifest } from '@/lib/shared';

const weekdayNumbers: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
function localClock(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { weekday: weekdayNumbers[values.weekday] ?? 1, minutes: Number(values.hour) * 60 + Number(values.minute) };
}
function toMinutes(value: string) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function scheduledPlaylistId(manifest: ScreenManifest, now = new Date()): string | null {
  for (const rule of manifest.schedules) {
    if (!rule.enabled) continue;
    let clock: ReturnType<typeof localClock>;
    try { clock = localClock(now, rule.timezone || manifest.screen.timezone || 'Asia/Riyadh'); }
    catch { clock = localClock(now, 'Asia/Riyadh'); }
    const start = toMinutes(rule.startTime);
    const end = toMinutes(rule.endTime);
    const today = rule.weekdays.includes(clock.weekday);
    const yesterday = rule.weekdays.includes(clock.weekday === 1 ? 7 : clock.weekday - 1);
    const active = start < end
      ? today && clock.minutes >= start && clock.minutes < end
      : (today && clock.minutes >= start) || (yesterday && clock.minutes < end);
    if (active) return rule.playlistId;
  }
  return manifest.defaultPlaylistId;
}
