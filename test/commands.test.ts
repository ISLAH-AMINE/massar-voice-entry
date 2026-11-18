import { describe, it, expect } from 'vitest';
import { matchCommand } from '../src/voice/commands';

const kind = (s: string, pickOpen = false) => matchCommand(s, { pickOpen })?.kind ?? null;

describe('voice commands — whole utterance only', () => {
  it.each([
    ['واخا', 'confirm'], ['واخا.', 'confirm'], ['وخا', 'confirm'], ['أوكي', 'confirm'], ['OK', 'confirm'],
    ['لا', 'cancel'], ['لا.', 'cancel'], ['لا لا', 'cancel'], ['إلغاء', 'cancel'],
    ['غايب', 'absent'], ['غائب', 'absent'],
    ['رجع', 'undo'], ['رجع.', 'undo'], ['تراجع', 'undo'],
    ['شكون بقا', 'missing'], ['شكون بقى؟', 'missing'], ['اشكون باقي', 'missing'], ['شكون لي بقا', 'missing'],
    ['حبس', 'stop'], ['وقف', 'stop'],
    ['سجل', 'export'], ['سجّل', 'export'], ['صدر الملف', 'export'],
  ])('%s → %s', (s, k) => expect(kind(s)).toBe(k));

  it.each([
    ['فرض تاني', 1], ['الفرض الثاني', 1], ['فرض جوج', 1], ['فرض 2', 1],
    ['فرض تالت', 2], ['الفرض الثالث', 2], ['فرض تلاتة', 2],
    ['فرض الأول', 0], ['فرض لول', 0], ['الفرض رقم 1', 0],
    ['الأنشطة', 3], ['الأنشطة المندمجة', 3], ['انشطة', 3],
  ])('%s → exam %i', (s, i) => expect(matchCommand(s)).toEqual({ kind: 'exam', index: i }));

  it('picker numbers only while the picker is open', () => {
    expect(matchCommand('واحد', { pickOpen: true })).toEqual({ kind: 'pick', index: 0 });
    expect(matchCommand('جوج', { pickOpen: true })).toEqual({ kind: 'pick', index: 1 });
    expect(matchCommand('زوج.', { pickOpen: true })).toEqual({ kind: 'pick', index: 1 });
    expect(matchCommand('تلاتة', { pickOpen: true })).toEqual({ kind: 'pick', index: 2 });
    expect(matchCommand('2', { pickOpen: true })).toEqual({ kind: 'pick', index: 1 });
    expect(kind('واحد')).toBeNull(); // no picker → it's a score (1), not a command
    expect(kind('جوج')).toBeNull();
  });

  it('commands inside a longer phrase are NOT commands', () => {
    expect(kind('بوزيدي عثمان واخا')).toBeNull();
    expect(kind('لا ربع')).toBeNull();
    expect(kind('تلطاش لا ربع')).toBeNull();
    expect(kind('رجع بوزيدي')).toBeNull();
    expect(kind('بوزيدي عثمان 15')).toBeNull();
    expect(kind('رقم 5 خمسطاش')).toBeNull();
    expect(kind('فرض')).toBeNull();
    expect(kind('')).toBeNull();
  });
});
