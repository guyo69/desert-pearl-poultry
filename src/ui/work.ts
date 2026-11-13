// One colour for each kind of work, the same on every screen, so people learn
// it once: blue is eggs or goods coming in, teal going out, green selling and
// money in, indigo counting and readings, red losses, pink money out, orange
// producing, grey the whole-day sheets. The icon says what exactly.
export type Work = 'in' | 'out' | 'sell' | 'check' | 'loss' | 'spend' | 'make' | 'sheet';
export const WORK_COLOR: Record<Work, string> = {
  in: '--info', out: '--l-tuala', sell: '--l-farm', check: '--l-rayan', loss: '--f-none', spend: '--l-lucky', make: '--l-van', sheet: '--muted',
};
export const WORK_NAME: Record<Work, string> = {
  in: 'Coming in', out: 'Going out', sell: 'Selling and money in', check: 'Counting and readings', loss: 'Losses', spend: 'Money out', make: 'Producing', sheet: 'Whole-day sheets',
};
