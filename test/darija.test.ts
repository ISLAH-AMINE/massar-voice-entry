import { describe, it, expect } from 'vitest';
import { parseScore, extractTrailingScore } from '../src/score/darija';

const ok = (raw: string, value: number) => it(`"${raw}" → ${value}`, () => expect(parseScore(raw)).toEqual({ ok: true, value }));
const invalid = (raw: string) =>
  it(`"${raw}" → invalid`, () => {
    const r = parseScore(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('invalid');
  });
const nomatch = (raw: string) =>
  it(`"${raw}" → nomatch`, () => {
    const r = parseScore(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe('nomatch');
  });

describe('whole numbers — Darija', () => {
  ok('صفر', 0);
  ok('واحد', 1);
  ok('جوج', 2);
  ok('زوج', 2);
  ok('تلاتة', 3);
  ok('ربعة', 4);
  ok('خمسة', 5);
  ok('ستة', 6);
  ok('سبعة', 7);
  ok('تمنية', 8);
  ok('تسعة', 9);
  ok('عشرة', 10);
  ok('حداش', 11);
  ok('طناش', 12);
  ok('اطناش', 12);
  ok('تلطاش', 13);
  ok('ربعطاش', 14);
  ok('خمسطاش', 15);
  ok('سطاش', 16);
  ok('سبعطاش', 17);
  ok('تمنطاش', 18);
  ok('تسعطاش', 19);
  ok('عشرين', 20);
});

describe('spelling variants', () => {
  ok('ثلاثة', 3);
  ok('أربعة', 4);
  ok('ثمانية', 8);
  ok('خمستاش', 15); // ت instead of ط
  ok('تلتاش', 13);
  ok('ستاش', 16);
  ok('خمسطاشر', 15); // trailing ر
  ok('حضاش', 11);
  ok('إطناش', 12);
  ok('اتناش', 12);
  ok('خَمْسَة', 5); // tashkeel
  ok('خمســطاش', 15); // tatweel
  ok('  خمسطاش   ونص ', 15.5);
  ok('خمس طاش', 15); // split by the recognizer
  ok('خمس تاش و نص', 15.5);
  ok('تلت طاش', 13);
  ok('ست طاش', 16);
  ok('سبع طاش لا ربع', 16.75);
});

describe('MSA', () => {
  ok('خمسة عشر', 15);
  ok('أحد عشر', 11);
  ok('اثنا عشر', 12);
  ok('تسعة عشر', 19);
  ok('عشرون', 20);
  ok('ثلاثة عشر ونصف', 13.5);
});

describe('digits', () => {
  ok('12', 12);
  ok('0', 0);
  ok('20', 20);
  ok('15.5', 15.5);
  ok('15,5', 15.5);
  ok('9.75', 9.75);
  ok('١٢', 12);
  ok('١٥٫٥', 15.5);
  ok('15/20', 15);
  ok('15 على 20', 15);
  ok('خمسطاش على عشرين', 15);
});

describe('recognizer punctuation (Chrome adds a final full stop)', () => {
  ok('19.', 19);
  ok('19 .', 19);
  ok('١٩.', 19);
  ok('15.5.', 15.5);
  ok('خمسطاش ونص.', 15.5);
  ok('12 و ربع.', 12.25);
  ok('تسعطاش؟', 19);
  ok('عشرة!', 10);
  ok('.15', 15);
  invalid('25.');
});

describe('fractions', () => {
  ok('خمسطاش ونص', 15.5);
  ok('خمسطاش و نص', 15.5);
  ok('خمسطاش و نصف', 15.5);
  ok('عشرة و ربع', 10.25);
  ok('عشرة وربع', 10.25);
  ok('تلطاش لا ربع', 12.75);
  ok('تلطاش إلا ربع', 12.75);
  ok('تلطاش الا ربع', 12.75);
  ok('تلطاش غير ربع', 12.75);
  ok('تلطاش لاربع', 12.75);
  ok('واحد لا ربع', 0.75);
  ok('تسعطاش ونص', 19.5);
  ok('صفر و ربع', 0.25);
});

describe('mixed digits + words', () => {
  ok('12 و ربع', 12.25);
  ok('12 ونص', 12.5);
  ok('12ونص', 12.5);
  ok('13 لا ربع', 12.75);
  ok('نقطة 14', 14);
});

describe('rejected: out of range / not a quarter', () => {
  invalid('21');
  invalid('25');
  invalid('عشرين ونص');
  invalid('واحد و عشرين');
  invalid('صفر لا ربع');
  invalid('12.3');
  invalid('12.1');
  invalid('19.99');
});

describe('rejected: not a score', () => {
  nomatch('');
  nomatch('بوزيدي');
  nomatch('لا');
  nomatch('واخا');
  nomatch('ونص');
  nomatch('خمسطاش عشرين');
  nomatch('15.5 ونص');
  nomatch('12 13');
  nomatch('-3');
  nomatch('خمسطاش ونص زيادة');
});

describe('extractTrailingScore', () => {
  const cases: [string, string, number][] = [
    ['بوزيدي عثمان خمسطاش ونص', 'بوزيدي عثمان', 15.5],
    ['بوزيدي عثمان خمسطاش و نص', 'بوزيدي عثمان', 15.5],
    ['عثمان تلطاش لا ربع', 'عثمان', 12.75],
    ['الفاسي اية 12', 'الفاسي اية', 12],
    ['الفاسي اية 12 و ربع', 'الفاسي اية', 12.25],
    ['الوزاني عبد الرحمان خمسة عشر', 'الوزاني عبد الرحمان', 15],
    ['منصوري فاطمة الزهراء 15 على 20', 'منصوري فاطمة الزهراء', 15],
    ['خمسطاش', '', 15],
  ];
  for (const [raw, name, value] of cases)
    it(`"${raw}"`, () => {
      const r = extractTrailingScore(raw)!;
      expect(r.name).toBe(name);
      expect(r.score).toEqual({ ok: true, value });
    });

  it('returns invalid score for out-of-range tail', () => {
    const r = extractTrailingScore('بوزيدي عثمان 25')!;
    expect(r.name).toBe('بوزيدي عثمان');
    expect(r.score.ok).toBe(false);
  });
  it('returns null when there is no score', () => {
    expect(extractTrailingScore('بوزيدي عثمان')).toBeNull();
  });
});
