// The report's knowledge base: what a laying flock should do at its age, so a
// week's figures are judged against a fair standard rather than a flat target.
//
// Source: Hy-Line Brown Commercial Layers, Performance Standards (conventional
// systems), hyline.com, "BRN STD ENG". The app uses the low end of each
// published range: open-sided houses in a hot climate rarely reach the top of
// a breed company's range, and a flock at the low end is still doing its job.
// Beyond 100 weeks the guide stops; the app carries the last published rate of
// decline on, and says so in the report.

/** Hen-day production, low end of the published range, % by age in weeks. */
const LAY: [number, number][] = [
  [18, 6.7], [20, 52.5], [25, 93.4], [30, 93.3], [35, 92.7], [40, 91.9], [45, 91.1], [50, 90.0], [55, 88.8], [60, 87.4],
  [65, 85.4], [70, 83.6], [75, 81.7], [80, 79.7], [85, 77.6], [90, 75.4], [95, 73.1], [100, 70.8],
];
/** Cumulative mortality %, by age in weeks. */
const MORT: [number, number][] = [[20, 0.32], [25, 0.53], [30, 0.77], [40, 1.32], [50, 1.99], [60, 2.83], [70, 3.86], [80, 5.13], [90, 6.69], [100, 8.6]];

export const GUIDE = {
  name: 'Hy-Line Brown performance standard',
  feedG: [110, 118] as [number, number],          // g per hen per day in lay
  waterMl: [165, 236] as [number, number],        // ml per hen per day
  fcr: [2.15, 2.24] as [number, number],          // kg feed per kg eggs, 20 to 100 weeks
  eggG: 62,                                       // typical egg weight in lay, g
  /** feed per egg the guide implies: FCR x egg weight */
  feedPerEggG: [2.15 * 60, 2.24 * 64] as [number, number],
  crackedPct: 2,                                  // cracked or damaged at collection above this needs a look
  peakWeeks: [25, 35] as [number, number],
  pointOfLayWeeks: 18,
  rearWeeks: 18,                                  // a day-old chick takes about this long to reach point of lay
  usualEndWeeks: [80, 100] as [number, number],   // most commercial flocks are replaced in this window
};

const HYBRIDS = /hy-?line|isa|lohmann|bovans|dekalb|novogen|hisex|babcock|shaver|tetra|brown|white|leghorn|hybrid|commercial/i;
/** Breeds the guide fits: commercial hybrids. Unknown breeds are treated as brown hybrids; local and dual-purpose breeds have no guide in the app. */
export function guideFits(breed?: string | null): 'yes' | 'assumed' | 'no' {
  if (!breed || !breed.trim()) return 'assumed';
  return HYBRIDS.test(breed) ? 'yes' : 'no';
}

const interp = (t: [number, number][], x: number) => {
  if (x <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) if (x <= t[i][0]) {
    const [x0, y0] = t[i - 1], [x1, y1] = t[i];
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  // past the guide: carry the last published rate of change on
  const [x0, y0] = t[t.length - 2], [x1, y1] = t[t.length - 1];
  return y1 + (y1 - y0) / (x1 - x0) * (x - x1);
};

/** Expected hen-day lay rate (0 to 1) for a flock of this age, and whether the age is past the published guide. */
export function expectedLay(ageWeeks: number): { rate: number; beyond: boolean } {
  return { rate: Math.max(0, Math.min(0.99, interp(LAY, ageWeeks) / 100)), beyond: ageWeeks > LAY[LAY.length - 1][0] };
}
/** Mortality the guide expects in one week at this age, as a share of the hens (0.002 = 0.2%). */
export function weeklyMortality(ageWeeks: number): number {
  const a = Math.max(20, ageWeeks);
  return Math.max(0.0004, (interp(MORT, a + 1) - interp(MORT, a)) / 100);
}

/** The farm's own target when it is realistic; a target of 97% or more is treated as not set. */
export const realisticTarget = (expected: number) => expected > 0 && expected < 0.97;

export type Stage = 'rearing' | 'coming into lay' | 'peak' | 'laying' | 'late lay' | 'past the usual cycle';
export function stage(age: number): Stage {
  if (age < GUIDE.pointOfLayWeeks) return 'rearing';
  if (age < GUIDE.peakWeeks[0]) return 'coming into lay';
  if (age <= GUIDE.peakWeeks[1]) return 'peak';
  if (age < 70) return 'laying';
  if (age <= GUIDE.usualEndWeeks[1]) return 'late lay';
  return 'past the usual cycle';
}
