import { describe, it, expect } from 'vitest';
import { chatterReason, fractionOnly, Stabilizer, MAX_ENTRY_WORDS } from '../src/voice/noise';
import { matchCommand, endsWithRestart } from '../src/voice/commands';
import { NameIndex } from '../src/match/names';
import { interpret, interpretOne, SURE_MATCH } from '../src/voice/interpret';

describe('chatterReason', () => {
  it('accepts normal entries', () => {
    expect(chatterReason('بوزيدي عثمان خمسطاش ونص', 0.8)).toBeNull();
    expect(chatterReason('رقم 12 خمسطاش و نص', 0)).toBeNull(); // 0 = confidence not reported
    expect(chatterReason('الوزاني عبد الرحمان تلطاش لا ربع', 0.9)).toBeNull();
  });
  it('rejects long background sentences', () => {
    const long = 'واش مشيتي البارح عند خالتك ولا بقيتي فالدار حتى لليل';
    expect(long.split(' ').length).toBeGreaterThan(MAX_ENTRY_WORDS);
    expect(chatterReason(long, 0.9)).not.toBeNull();
  });
  it('rejects low-confidence results', () => {
    expect(chatterReason('بوزيدي 12', 0.2)).not.toBeNull();
  });
});

describe('fractionOnly', () => {
  it.each([
    ['ونص', 0.5], ['و نص', 0.5], ['و نصف.', 0.5], ['و ربع', 0.25], ['وربع', 0.25],
    ['لا ربع', -0.25], ['إلا ربع', -0.25], ['لاربع', -0.25],
  ])('%s → %f', (s, v) => expect(fractionOnly(s)).toBe(v));
  it.each([['نص'], ['خمسطاش ونص'], ['لا'], ['ربع'], ['']])('%s → null', (s) => expect(fractionOnly(s)).toBeNull());
});

describe('restart command «عاود»', () => {
  it('whole utterance', () => {
    expect(matchCommand('عاود')).toEqual({ kind: 'restart' });
    expect(matchCommand('عاود.')).toEqual({ kind: 'restart' });
    expect(matchCommand('من جديد')).toEqual({ kind: 'restart' });
  });
  it('at the end of a stuck phrase full of chatter', () => {
    expect(endsWithRestart('واش كاين شي قهوة كحلة عاود')).toBe(true);
    expect(endsWithRestart('كلام كثير عاود من جديد')).toBe(true);
    expect(endsWithRestart('عاود')).toBe(true);
  });
  it('not when عاود is in the middle or absent', () => {
    expect(endsWithRestart('عاود بوزيدي عثمان 12')).toBe(false);
    expect(endsWithRestart('بوزيدي عثمان خمسطاش')).toBe(false);
    expect(endsWithRestart('')).toBe(false);
  });
});

describe('Stabilizer', () => {
  const complete = (t: string) => /\d/.test(t);
  it('commits a complete partial text once it stops changing', () => {
    const s = new Stabilizer(complete, 1000);
    s.feed('بوزيدي', 0);
    expect(s.check(1500)).toBeNull(); // not complete
    s.feed('بوزيدي عثمان 15', 1600);
    expect(s.check(2000)).toBeNull(); // not stable yet
    expect(s.check(2600)).toBe('بوزيدي عثمان 15');
    expect(s.check(4000)).toBeNull(); // fires once
  });
  it('restarts the clock when the text changes', () => {
    const s = new Stabilizer(complete, 1000);
    s.feed('بوزيدي عثمان 15', 0);
    s.feed('بوزيدي عثمان 15 و نص', 900);
    expect(s.check(1200)).toBeNull();
    expect(s.check(1900)).toBe('بوزيدي عثمان 15 و نص');
  });
  it('reset drops the pending text', () => {
    const s = new Stabilizer(complete, 100);
    s.feed('x 1', 0);
    s.reset();
    expect(s.check(500)).toBeNull();
  });
});

describe('match certainty for voice', () => {
  const roster = ['بوزيدي عمران', 'بوزيدي عثمان', 'الفاسي اية', 'الحسني حمزة'].map((name, i) => ({ name, row: 18 + i }));
  const idx = new NameIndex(roster);
  const score = (t: string) => {
    const r = interpretOne(t, idx);
    return r.kind === 'entry' || r.kind === 'student' ? r.matchScore : -1;
  };
  it('full names, unique surnames and «رقم» are sure', () => {
    expect(score('بوزيدي عثمان 12')).toBeGreaterThanOrEqual(SURE_MATCH);
    expect(score('الفاسي 12')).toBeGreaterThanOrEqual(SURE_MATCH);
    expect(score('حمزة 12')).toBeGreaterThanOrEqual(SURE_MATCH);
    expect(score('رقم 2 12')).toBe(1);
  });
  it('a single misheard word is not sure (asks first)', () => {
    const s = score('حمدة 12');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(SURE_MATCH);
  });
  it('interpret keeps the score', () => {
    const r = interpret(['الفاسي اية 15'], idx);
    expect(r.kind === 'entry' && r.matchScore).toBe(1);
  });
});
