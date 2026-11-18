import { describe, it, expect } from 'vitest';
import { NameIndex } from '../src/match/names';
import { interpret } from '../src/voice/interpret';

const roster = ['الحسني حمزة', 'بوزيدي عمران', 'بوزيدي عثمان', 'الفاسي اية', 'الوزاني عبد الرحمان', 'الصقلي مروى', 'الصقلي مروان'].map((name, i) => ({
  name,
  row: 18 + i,
}));
const idx = new NameIndex(roster);
const value = (r: any) => (r.ex?.score.ok ? r.ex.score.value : r.score?.ok ? r.score.value : undefined);

describe('interpret', () => {
  it('name + Darija score', () => {
    const r = interpret(['بوزيدي عثمان خمسطاش ونص'], idx);
    expect(r.kind).toBe('entry');
    if (r.kind === 'entry') expect(r.student.name).toBe('بوزيدي عثمان');
    expect(value(r)).toBe(15.5);
  });

  it('recognizer digits', () => {
    const r = interpret(['بوزيدي عثمان 15 و نص'], idx);
    expect(r.kind).toBe('entry');
    expect(value(r)).toBe(15.5);
  });

  it('first name only + score', () => {
    const r = interpret(['آية تلطاش لا ربع'], idx);
    expect(r.kind).toBe('entry');
    if (r.kind === 'entry') expect(r.student.name).toBe('الفاسي اية');
    expect(value(r)).toBe(12.75);
  });

  it('twins → pick, keeps the score', () => {
    const r = interpret(['بوزيدي خمسطاش'], idx);
    expect(r.kind).toBe('pick');
    if (r.kind === 'pick') expect(r.options.map((s) => s.name).sort()).toEqual(['بوزيدي عثمان', 'بوزيدي عمران']);
    expect(value(r)).toBe(15);
  });

  it('name only → student', () => {
    const r = interpret(['الوزاني عبد الرحمان'], idx);
    expect(r.kind).toBe('student');
  });

  it('score only → scoreOnly', () => {
    const r = interpret(['تسعطاش'], idx);
    expect(r.kind).toBe('scoreOnly');
    expect(value(r)).toBe(19);
  });

  it('out-of-range score is reported, not dropped', () => {
    const r = interpret(['بوزيدي عثمان 25'], idx);
    expect(r.kind).toBe('entry');
    if (r.kind === 'entry') expect(r.ex.score.ok).toBe(false);
  });

  it('unknown name', () => {
    expect(interpret(['زينب خمسة'], idx).kind).toBe('unknown');
    expect(interpret([''], idx).kind).toBe('unknown');
  });

  it('prefers the alternative that yields a confident entry', () => {
    // alt 1 heard the surname only (ambiguous), alt 2 heard the full name
    const r = interpret(['بوزيدي خمسطاش', 'بوزيدي عثمان خمسطاش'], idx);
    expect(r.kind).toBe('entry');
    if (r.kind === 'entry') expect(r.student.name).toBe('بوزيدي عثمان');
  });

  it('prefers a valid score over an out-of-range one among alternatives', () => {
    const r = interpret(['الصقلي مروى 25', 'الصقلي مروى 15'], idx);
    expect(value(r)).toBe(15);
  });

  it('keeps the first alternative when it is already a confident entry', () => {
    const r = interpret(['الصقلي مروى عشرة', 'الصقلي مروان عشرة'], idx);
    if (r.kind === 'entry') expect(r.student.name).toBe('الصقلي مروى');
    else throw new Error(r.kind);
  });

  it('a bare score is not replaced by a name-like alternative («خمسة» vs «حمزة»)', () => {
    expect(interpret(['خمسة', 'حمزة'], idx).kind).toBe('scoreOnly');
    expect(interpret(['خمسة', 'حمزة'], idx, { awaitingScore: true }).kind).toBe('scoreOnly');
  });

  it('while waiting for a score, a valid score alternative wins over a name', () => {
    const r = interpret(['حمزة', 'خمسة'], idx, { awaitingScore: true });
    expect(r.kind).toBe('scoreOnly');
    expect(value(r)).toBe(5);
  });

  it('a name-only first reading is not replaced by a bare score when nothing is awaited', () => {
    expect(interpret(['حمزة', 'خمسة'], idx).kind).toBe('student');
  });

  it('an unknown first reading can be replaced by any useful alternative', () => {
    expect(interpret(['زينب', 'خمسة'], idx).kind).toBe('scoreOnly');
  });

  it('split teen from the recognizer', () => {
    const r = interpret(['بوزيدي عثمان خمس طاش و نص'], idx);
    expect(r.kind).toBe('entry');
    expect(value(r)).toBe(15.5);
  });

  it('Chrome punctuation: «الحداد نبيلة.» then «19.»', () => {
    const idx2 = new NameIndex([{ name: 'الحداد نبيلة' }, { name: 'الفاسي اية' }]);
    expect(interpret(['الحداد نبيلة.'], idx2).kind).toBe('student');
    const r = interpret(['19.'], idx2, { awaitingScore: true });
    expect(r.kind).toBe('scoreOnly');
    expect(value(r)).toBe(19);
    const e = interpret(['الحداد نبيلة 15.5.'], idx2);
    expect(e.kind).toBe('entry');
    expect(value(e)).toBe(15.5);
  });

  it('by number: «رقم 2 خمسطاش» → 2nd student in the list', () => {
    const r = interpret(['رقم 2 خمسطاش.'], idx);
    expect(r.kind).toBe('entry');
    if (r.kind === 'entry') expect(r.student.name).toBe(roster[1].name);
    expect(value(r)).toBe(15);
  });

  it('by number only, then score', () => {
    const r = interpret(['رقم تلاتة'], idx);
    expect(r.kind).toBe('student');
    if (r.kind === 'student') expect(r.student.name).toBe(roster[2].name);
  });

  it('number past the end of the list', () => {
    const r = interpret(['رقم 40 خمسة'], idx);
    expect(r.kind).toBe('unknown');
  });

  it('learned alias resolves a misheard name', () => {
    const idx2 = new NameIndex(roster);
    expect(interpret(['فلفلة 12'], idx2).kind).not.toBe('entry');
    idx2.addAlias('فلفلة', roster[2]);
    const r = interpret(['فلفلة. 12'], idx2);
    expect(r.kind).toBe('entry');
    if (r.kind === 'entry') expect(r.student).toBe(roster[2]);
  });
});
