// Golden queries: what people type, and what must come up first. When a
// change to search breaks one of these, fix search rather than the test.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dayIn, search, SECTIONS, type TabLite } from '../src/lib/search';
import type { Dashboard, Role } from '../src/lib/types';

const LABEL: Record<string, [string, string]> = {
  ov: ['Overview', 'dash'], alerts: ['Alerts', 'bell'], stock: ['Stock', 'box'], money: ['Money', 'wallet'], report: ['Report', 'report'], activity: ['Activity', 'list'],
  settings: ['Settings', 'sliders'], home: ['Home', 'dash'], feed: ['Feed', 'sack'], mill: ['Feed mill', 'scoop'], water: ['Water', 'drop'], health: ['Flock health', 'syringe'],
  records: ['Records', 'list'], store: ['Store', 'box'], meds: ['Store items', 'syringe'], srecords: ['Records', 'list'], today: ['Today', 'dash'], pstock: ['Stock', 'box'],
  psales: ['Sales', 'receipt'], pmoney: ['Money', 'wallet'], me: ['My account', 'user'],
};
const ROLE_TABS: Record<Role, string[]> = {   // as in App.tsx
  owner: ['ov', 'stock', 'money', 'report', 'activity', 'alerts', 'feed', 'mill', 'water', 'health', 'settings'],
  manager: ['alerts', 'ov', 'stock', 'report', 'health', 'feed', 'mill', 'water', 'money', 'records', 'activity', 'settings'],
  clerk: ['home', 'feed', 'water', 'health', 'records', 'me'],
  store: ['store', 'mill', 'feed', 'meds', 'srecords', 'me'],
  pos: ['today', 'pstock', 'psales', 'pmoney', 'me'],
};
const RAW = [
  { id: 1, name: 'Maize', per_tonne: 533, bag_kg: 90, active: true, sort: 1, stock: 5400 },
  { id: 2, name: 'Wheat bran', per_tonne: 180, bag_kg: 50, active: true, sort: 2, stock: 1273 },
  { id: 3, name: 'Soybean', per_tonne: 130, bag_kg: 50, active: true, sort: 3, stock: 900 },
  { id: 4, name: 'Sunflower cake', per_tonne: 50, bag_kg: 50, active: true, sort: 4, stock: 400 },
  { id: 5, name: 'Limestone (white)', per_tonne: 50, bag_kg: 50, active: true, sort: 5, stock: 300 },
];
function load(name: string, role?: Role): [Dashboard, TabLite[]] {
  const D = JSON.parse(readFileSync(`tests/fixtures/${name}.json`, 'utf8')).dashboard as Dashboard;
  if (role) D.me = { ...D.me, role };
  D.raw = RAW;
  D.credits = [{ location_id: 'RAYAN', customer: 'Mama Njeri', owed: 1350, since: '2026-10-27', sales: 2, last_paid: null },
    { location_id: 'TUALA', customer: 'Hotel Baraka', owed: 4200, since: '2026-10-25', sales: 3, last_paid: null }];
  const tabs = ROLE_TABS[D.me.role].map((k) => ({ key: k, label: LABEL[k][0], icon: LABEL[k][1] }));
  return [D, tabs];
}
const top = (n: [Dashboard, TabLite[]], q: string, k = 1) => search(n[0], n[1], q).slice(0, k).map((h) => h.key);

const owner = load('owner'), manager = load('manager'), clerk = load('clerk'), store = load('clerk', 'store'), shop = load('rayan'), van = load('van');

describe('golden searches', () => {
  it('owner', () => {
    expect(search(owner[0], owner[1], 'workbook')[0].group).toBe('Download');
    expect(search(owner[0], owner[1], 'excel')[0].group).toBe('Download');
    expect(search(owner[0], owner[1], 'download october workbook')[0].key).toMatch(/^d:\d{4}-10-01$/);
    expect(top(owner, 'sales today')).toEqual(['q:sales']);
    expect(top(owner, 'rayan')).toEqual(['l:RAYAN']);
    expect(top(owner, 'raian', 3)).toContain('l:RAYAN');            // a typo
    expect(top(owner, 'who owes', 3)).toEqual(expect.arrayContaining(['s:Outstanding credits', 'c:TUALA:Hotel Baraka']));
    expect(top(owner, 'njeri')).toEqual(['c:RAYAN:Mama Njeri']);
    expect(['s:Staff', 'a:staff']).toContain(top(owner, 'staff')[0]);
    expect(top(owner, 'tank', 2)).toContain('q:tank');
    expect(top(owner, 'recipe', 2)).toContain('a:recipe');
    expect(top(owner, 'password', 3)).toContain('s:My account');
  });
  it('farm manager', () => {
    expect(top(manager, 'missed day', 2)).toContain('s:Days with gaps');
    expect(top(manager, 'yesterday')[0]).toMatch(/^day:/);
    expect(top(manager, '27 oct')).toEqual(['day:2026-10-27']);          // the fixtures' today is 29 Oct 2026
    expect(top(manager, 'feed left')).toEqual(['q:feed']);
    expect(top(manager, 'expense')).toEqual(['a:expense']);
    expect(top(manager, 'dawa', 3).some((k) => k.startsWith('m:') || k === 'a:med_issue' || k === 'a:med_in' || k === 's:Medicine & vaccine store')).toBe(true);
  });
  it('production clerk', () => {
    expect(['a:collect', 'q:eggs']).toContain(top(clerk, 'mayai')[0]);
    expect(top(clerk, 'eggs today')).toEqual(['q:eggs']);
    expect(['a:tank', 'q:tank']).toContain(top(clerk, 'tank')[0]);
    expect(top(clerk, 'maji', 3)).toContain('a:water');
    expect(top(clerk, 'dead', 2)).toContain('a:mortality');
    expect(['a:mortality', 'q:deaths']).toContain(top(clerk, 'wamekufa')[0]);
    expect(top(clerk, 'egg colection')).toEqual(['a:collect']);   // a typo
    expect(top(clerk, 'house a', 2)).toContain(`h:${clerk[0].houses[0].id}`);
    expect(search(clerk[0], clerk[1], 'workbook').some((h) => h.group === 'Download')).toBe(false);
  });
  it('inventory clerk', () => {
    expect(top(store, 'maize')).toEqual(['r:1']);
    expect(top(store, 'mahindi', 2)).toContain('r:1');
    expect(top(store, 'feed left')).toEqual(['q:feed']);
    expect(top(store, 'mill', 2)).toContain('a:mill');
    expect(top(store, 'newcastle', 1)[0]).toMatch(/^m:/);
  });
  it('knows the names people use for medicines and raw materials', () => {
    const first = (q: string) => search(store[0], store[1], q)[0]?.title ?? '';
    expect(first('kideri')).toMatch(/Newcastle/);          // Kiswahili for Newcastle disease
    expect(first('minyoo')).toMatch(/Dewormer/);           // worms
    expect(first('worms')).toMatch(/Dewormer/);
    expect(first('vitamini')).toMatch(/Multivitamin/);
    expect(first('antibiotic')).toMatch(/Oxytetracycline/);
    expect(first('alizeti')).toMatch(/Sunflower/);
    expect(first('chokaa')).toMatch(/Limestone/);
  });
  it('outlet attendant', () => {
    expect(top(shop, 'sael')).toEqual(['a:sale']);                 // a typo
    expect(top(shop, 'sell')).toEqual(['a:sale']);
    expect(top(shop, 'deni', 2)).toContain('a:credit_paid');
    expect(top(shop, 'close')).toEqual(['a:count_close']);
    expect(top(shop, 'njeri')).toEqual(['c:RAYAN:Mama Njeri']);
    expect(top(shop, 'baraka')).toEqual([]);                        // another outlet's customer
    const all = search(shop[0], shop[1], 'cash rayan', 30);
    expect(all.every((h) => !/cash KES/i.test(h.sub))).toBe(true); // blind counts: no expected cash
    expect(search(shop[0], shop[1], 'workbook').some((h) => h.group === 'Download')).toBe(false);
    expect(search(shop[0], shop[1], 'tuala').some((h) => h.key === 'l:TUALA')).toBe(false);
  });
  it('van driver', () => {
    expect(top(van, 'deliver', 2)).toContain('a:dispatch');
    expect(top(van, 'left over')).toEqual(['a:leftover']);
  });
  it('finds nothing for nonsense', () => {
    expect(search(owner[0], owner[1], 'xqzvw')).toEqual([]);
    expect(search(owner[0], owner[1], '   ')).toEqual([]);
  });
});

describe('days in a query', () => {
  it('reads common ways of naming a day', () => {
    expect(dayIn('yesterday', '2026-11-11')).toBe('2026-11-10');
    expect(dayIn('jana', '2026-11-11')).toBe('2026-11-10');
    expect(dayIn('3 nov', '2026-11-11')).toBe('2026-11-03');
    expect(dayIn('nov 3rd', '2026-11-11')).toBe('2026-11-03');
    expect(dayIn('28 december', '2026-11-11')).toBe('2025-12-28');
    expect(dayIn('2026-10-30', '2026-11-11')).toBe('2026-10-30');
    expect(dayIn('monday', '2026-11-11')).toBe('2026-11-09');
    expect(dayIn('mayai 3', '2026-11-11')).toBeNull();
    expect(dayIn('eggs today', '2026-11-11')).toBeNull();
  });
});

describe('sections', () => {
  it('names only cards that are on a screen', () => {
    const src = readdirSync('src/views').filter((f) => f.endsWith('.tsx')).map((f) => readFileSync(`src/views/${f}`, 'utf8')).join('\n');
    for (const s of SECTIONS) expect(src.includes(`"${s.title}"`) || src.includes(`'${s.title}'`), s.title).toBe(true);
  });
});
