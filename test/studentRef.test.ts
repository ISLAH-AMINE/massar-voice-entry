import { describe, it, expect } from 'vitest';
import { parseStudentRef } from '../src/match/studentRef';
import { parseCount, tokenizeScore } from '../src/score/darija';

const count = (s: string) => parseCount(tokenizeScore(s));

describe('parseCount', () => {
  it.each([
    ['1', 1], ['12', 12], ['واحد', 1], ['جوج', 2], ['تلاتة', 3], ['حداش', 11], ['خمسطاش', 15],
    ['عشرين', 20], ['خمسة عشر', 15], ['واحد و عشرين', 21], ['واحد وعشرين', 21], ['جوج و تلاتين', 32],
    ['تلاتين', 30], ['ربعين', 40], ['خمسة و ربعين', 45],
  ])('%s → %i', (s, n) => expect(count(s)).toBe(n));
  it.each([['0'], ['صفر'], ['بوزيدي'], ['12.5'], ['خمسطاش ونص'], ['']])('%s → null', (s) => expect(count(s)).toBeNull());
});

describe('parseStudentRef', () => {
  const ref = (s: string) => parseStudentRef(s);
  const score = (s: string) => {
    const r = ref(s);
    return r?.ex?.score.ok ? r.ex.score.value : undefined;
  };

  it('number only', () => {
    expect(ref('رقم 5')).toMatchObject({ n: 5, ex: null });
    expect(ref('رقم تلاتة')).toMatchObject({ n: 3, ex: null });
    expect(ref('الرقم 12.')).toMatchObject({ n: 12, ex: null });
    expect(ref('#7')).toMatchObject({ n: 7, ex: null });
    expect(ref('# 7')).toMatchObject({ n: 7, ex: null });
    expect(ref('نمرة 4')).toMatchObject({ n: 4, ex: null });
    expect(ref('رقم واحد و عشرين')).toMatchObject({ n: 21, ex: null });
    expect(ref('رقم 33')).toMatchObject({ n: 33, ex: null });
  });

  it('number + score', () => {
    expect(ref('رقم 5 15')?.n).toBe(5);
    expect(score('رقم 5 15')).toBe(15);
    expect(score('رقم 5 خمسطاش ونص')).toBe(15.5);
    expect(score('رقم تلاتة تلطاش لا ربع.')).toBe(12.75);
    expect(score('#12 15.5')).toBe(15.5);
    expect(score('رقم واحد و عشرين خمسطاش')).toBe(15);
    expect(ref('رقم واحد و عشرين خمسطاش')?.n).toBe(21);
    expect(score('رقم 30 12 و ربع')).toBe(12.25);
  });

  it('Darija: «رقم خمسة عشرة» = student 5, score 10', () => {
    expect(ref('رقم خمسة عشرة')).toMatchObject({ n: 5 });
    expect(score('رقم خمسة عشرة')).toBe(10);
  });

  it('out-of-range score is kept so the UI can show the error', () => {
    const r = ref('رقم 5 25');
    expect(r?.n).toBe(5);
    expect(r?.ex?.score.ok).toBe(false);
  });

  it('not a reference', () => {
    expect(ref('بوزيدي عثمان 15')).toBeNull();
    expect(ref('15')).toBeNull();
    expect(ref('رقم')).toBeNull();
    expect(ref('رقم بوزيدي')).toBeNull();
  });
});
