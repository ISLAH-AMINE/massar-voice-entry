import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { NameIndex, arabicSkeleton, latinToArabic } from '../src/match/names';
import { parseMassar } from '../src/xlsx/massar';
import { normalizeArabic } from '../src/text/normalize';

const roster = [
  'بوزيدي عمران',
  'بوزيدي عثمان',
  'الفاسي اية',
  'بالمختار ملاك',
  'الوزاني عبد الرحمان',
  'منصوري فاطمة الزهراء',
  'الشرقاوي زكرياء',
  'الحسني حمزة',
  'الإدريسي محمد',
  'بناني محمد',
  'شكري يوسف',
  'التازي عمران',
  'القادري مروان',
  'الصقلي مروى',
  'الصقلي مروان',
].map((name, i) => ({ name, row: 18 + i }));
const idx = new NameIndex(roster);

const confident = (q: string, expected: string) =>
  it(`"${q}" → ${expected}`, () => {
    const r = idx.match(q);
    expect(r.status, JSON.stringify(r.ranked.slice(0, 3).map((m) => [m.student.name, m.score.toFixed(2)]))).toBe('confident');
    expect(r.options[0].student.name).toBe(expected);
  });
const ambiguous = (q: string, expected: string[]) =>
  it(`"${q}" → ambiguous ${expected.join(' / ')}`, () => {
    const r = idx.match(q);
    expect(r.status).toBe('ambiguous');
    expect(r.options.map((m) => m.student.name).sort()).toEqual([...expected].sort());
  });
const none = (q: string) => it(`"${q}" → none`, () => expect(idx.match(q).status).toBe('none'));

describe('exact / order / partial', () => {
  confident('بوزيدي عثمان', 'بوزيدي عثمان');
  confident('عثمان بوزيدي', 'بوزيدي عثمان');
  confident('عثمان', 'بوزيدي عثمان');
  confident('الفاسي', 'الفاسي اية');
  confident('اية', 'الفاسي اية');
  confident('آية الفاسي', 'الفاسي اية');
  confident('ملاك', 'بالمختار ملاك');
  confident('عبد الرحمان', 'الوزاني عبد الرحمان');
  confident('عبدالرحمان الوزاني', 'الوزاني عبد الرحمان');
  confident('وزاني', 'الوزاني عبد الرحمان');
  confident('فاطمة الزهراء', 'منصوري فاطمة الزهراء');
  confident('منصوري', 'منصوري فاطمة الزهراء');
  confident('الادريسي محمد', 'الإدريسي محمد');
  confident('محمد بناني', 'بناني محمد');
  confident('منص', 'منصوري فاطمة الزهراء'); // typed prefix
});

describe('small errors (speech/typing)', () => {
  confident('بوزدي عثمان', 'بوزيدي عثمان');
  confident('بوزيدي عتمان', 'بوزيدي عثمان');
  confident('عتمان', 'بوزيدي عثمان');
  confident('زكريا الشرقاوي', 'الشرقاوي زكرياء');
  confident('الشرقاوى زكرياء', 'الشرقاوي زكرياء');
  confident('حمزه', 'الحسني حمزة');
  confident('الحسنى', 'الحسني حمزة');
  confident('شكرى يوسف', 'شكري يوسف');
  confident('الصقلي مروى', 'الصقلي مروى');
  confident('الصقلي مروان', 'الصقلي مروان');
  confident('عمران بوزيدي', 'بوزيدي عمران');
  confident('يوسوف', 'شكري يوسف');
  confident('بلمختار', 'بالمختار ملاك');
});

describe('never guess between close candidates', () => {
  ambiguous('بوزيدي', ['بوزيدي عمران', 'بوزيدي عثمان']);
  ambiguous('محمد', ['الإدريسي محمد', 'بناني محمد']);
  ambiguous('عمران', ['بوزيدي عمران', 'التازي عمران']); // and NOT مروان
  ambiguous('الصقلي', ['الصقلي مروى', 'الصقلي مروان']);
  ambiguous('مروان', ['القادري مروان', 'الصقلي مروان']);
});

describe('no match', () => {
  none('زينب');
  none('واخا');
  none('');
});

describe('Arabizi / Latin', () => {
  it('skeletons line up', () => {
    expect(arabicSkeleton(latinToArabic('bouzidi'), true)).toBe(arabicSkeleton('بوزيدي', true));
    expect(arabicSkeleton(latinToArabic('othmane'), true)).toBe(arabicSkeleton('عثمان', true));
    expect(arabicSkeleton(latinToArabic('7amza'), true)).toBe(arabicSkeleton('حمزة', true));
    expect(arabicSkeleton('عمران')).not.toBe(arabicSkeleton('مروان')); // ع kept for Arabic input
  });
  confident('bouzidi othmane', 'بوزيدي عثمان');
  confident('bouzidi 3otman', 'بوزيدي عثمان');
  confident('othmane', 'بوزيدي عثمان');
  confident('omrane bouzidi', 'بوزيدي عمران');
  it('"omrane" alone asks, offering both عمران', () => {
    const r = idx.match('omrane');
    expect(r.status).toBe('ambiguous');
    const names = r.options.map((m) => m.student.name);
    expect(names).toContain('بوزيدي عمران');
    expect(names).toContain('التازي عمران');
  });
  confident('7amza', 'الحسني حمزة');
  confident('hamza', 'الحسني حمزة');
  confident('youssef chokri', 'شكري يوسف');
  confident('zakaria', 'الشرقاوي زكرياء');
  confident('abderrahmane', 'الوزاني عبد الرحمان');
  confident('mansouri', 'منصوري فاطمة الزهراء');
  ambiguous('bouzidi', ['بوزيدي عمران', 'بوزيدي عثمان']);
});

// ---------- property tests over the real class lists ----------
const FIX = join(__dirname, 'fixtures');
// Real Massar exports are kept local only (student data, git-ignored): skip when absent.
const files = existsSync(FIX) ? readdirSync(FIX).filter((f) => f.endsWith('.xlsx')) : [];
if (!files.length) it.skip('real Massar exports not present in test/fixtures/', () => {});

describe.each(files)('real roster %s', (file) => {
  it('full name, reversed name, and a one-letter typo are never matched to the wrong student', async () => {
    const { students } = await parseMassar(new Uint8Array(readFileSync(join(FIX, file))));
    const index = new NameIndex(students);
    const sameName = (a: string, b: string) => normalizeArabic(a) === normalizeArabic(b);
    let confidentFull = 0;
    for (const st of students) {
      const dup = students.filter((s) => sameName(s.name, st.name)).length > 1;
      const toks = normalizeArabic(st.name).split(' ');
      const longest = toks.reduce((a, b) => (b.length > a.length ? b : a));
      const typo = toks.map((t) => (t === longest ? t.slice(0, -2) + t.slice(-1) : t)).join(' '); // drop 2nd-to-last letter
      // reverse order but keep compounds together: 'الناصري عبد الله' → 'عبد الله الناصري'
      const parts = normalizeArabic(st.name).replace(/(^| )(عبد|ابو) /g, '$1$2_').split(' ');
      const reversed = parts.reverse().join(' ').replace(/_/g, ' ');
      for (const q of [st.name, reversed, typo]) {
        const r = index.match(q);
        if (r.status === 'confident') expect(r.options[0].student, `"${q}" matched ${r.options[0].student.name}`).toBe(st);
        else if (r.status === 'ambiguous') expect(r.options.map((m) => m.student)).toContain(st);
        else throw new Error(`"${q}" found nobody (expected ${st.name}) codes=${[...q].map((c) => c.charCodeAt(0).toString(16)).join(",")}`);
      }
      const full = index.match(st.name);
      if (!dup) {
        expect(full.status, `full name "${st.name}"`).toBe('confident');
        confidentFull++;
      }
    }
    expect(confidentFull).toBeGreaterThan(students.length - 3);
  });
});
