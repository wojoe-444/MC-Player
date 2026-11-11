// Per player-hour figures. A count or a duration only means something next to how long the bots were online, so the dashboard shows
// the rate first (deaths per player-hour) and the raw total beside it. "Player-hour" = one bot online for one hour; two bots online
// for the same hour are two player-hours. Online time comes from the journal (dashboard/progress.js, `onlineMin`); a day with none
// has no rate, it is left out of both sides of the division instead of counting as zero.

/** Below this much online time a rate is noise (one death in 5 minutes is not "12 per hour"), so it is shown as a dash. */
export const MIN_ONLINE_MIN = 15

export type Counted = { value: number | null | undefined; onlineMin: number | null | undefined }

/** value per player-hour, or null when there is no usable online time. */
export function perHour(value: number | null | undefined, onlineMin: number | null | undefined): number | null {
  if (value == null || !onlineMin || onlineMin < MIN_ONLINE_MIN) return null
  return (value * 60) / onlineMin
}

/** Sum a series of days into one rate: only days with both a value and online time count, on both sides. */
export function pooledPerHour(days: Counted[]): { rate: number | null; total: number; onlineMin: number } {
  let total = 0, online = 0
  for (const d of days) if (d.value != null && d.onlineMin) { total += d.value; online += d.onlineMin }
  return { rate: perHour(total, online), total, onlineMin: online }
}

export const round1 = (n: number) => Math.round(n * 10) / 10

/** "2.4" for a rate, with a decimal below 10 and none above; null shows as a dash. */
export function fmtRate(r: number | null): string {
  if (r == null) return "–"
  return r >= 100 ? String(Math.round(r)) : r >= 10 ? r.toFixed(1).replace(/\.0$/, "") : String(round1(r))
}

/** "3h 20m" / "45m" */
export function fmtOnline(min: number | null | undefined): string {
  if (min == null) return "–"
  const m = Math.round(min)
  return m >= 60 ? `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}` : `${m}m`
}
