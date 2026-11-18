/**
 * Turn one recognized utterance (with the recognizer's alternatives) into an
 * action. Pure: no DOM, no timers — main.ts decides what to do with it.
 *
 * "بوزيدي عثمان خمسطاش ونص" → entry(بوزيدي عثمان, 15.5)
 * "بوزيدي خمسطاش"           → pick([بوزيدي عمران, بوزيدي عثمان], 15)
 * "بوزيدي عثمان"            → student(بوزيدي عثمان)   (score can follow)
 * "خمسطاش"                 → scoreOnly(15)          (for the selected student)
 */
import { extractTrailingScore, type Extracted, type ParseResult } from '../score/darija';
import type { NameIndex, Named } from '../match/names';
import { parseStudentRef } from '../match/studentRef';

export type Interpretation<T extends Named> =
  | { kind: 'entry'; student: T; ex: Extracted; heard: string; matchScore: number }
  | { kind: 'student'; student: T; heard: string; matchScore: number }
  | { kind: 'scoreOnly'; score: ParseResult; ex: Extracted; heard: string }
  | { kind: 'pick'; options: T[]; more: number; ex: Extracted | null; heard: string; nameText: string }
  | { kind: 'unknown'; heard: string; reason: string; nameText?: string; ex?: Extracted | null };

export interface InterpretContext {
  /** a student was just named without a score: a bare score is what we expect next */
  awaitingScore?: boolean;
}

/** Lower = better. Used to choose between the recognizer's alternatives. */
function rank(i: Interpretation<Named>, ctx: InterpretContext): number {
  switch (i.kind) {
    case 'entry':
      return i.ex.score.ok ? 0 : 3;
    case 'pick':
      return i.ex?.score.ok ? 1 : 4;
    case 'student':
      return 2;
    case 'scoreOnly':
      return i.score.ok ? (ctx.awaitingScore ? 0.5 : 5) : 6;
    case 'unknown':
      return 9;
  }
}

export function interpretOne<T extends Named>(heard: string, index: NameIndex<T>): Interpretation<T> {
  const text = heard.trim();
  if (!text) return { kind: 'unknown', heard, reason: 'لم أسمع شيئاً' };

  // «رقم 5 [score]» — by position in the list
  const ref = parseStudentRef(text);
  if (ref) {
    const student = index.at(ref.n);
    if (!student) return { kind: 'unknown', heard, reason: `لا يوجد تلميذ رقم ${ref.n}` };
    return ref.ex ? { kind: 'entry', student, ex: ref.ex, heard, matchScore: 1 } : { kind: 'student', student, heard, matchScore: 1 };
  }

  const ex = extractTrailingScore(text);
  if (ex && !ex.name) return { kind: 'scoreOnly', score: ex.score, ex, heard };

  const nameText = ex ? ex.name : text;
  const m = index.match(nameText);
  if (m.status === 'none') return { kind: 'unknown', heard, reason: `لم أجد «${nameText}»`, nameText, ex };
  if (m.status === 'ambiguous') return { kind: 'pick', options: m.options.map((o) => o.student), more: m.more, ex, heard, nameText };
  const student = m.options[0].student;
  const matchScore = m.options[0].score;
  return ex ? { kind: 'entry', student, ex, heard, matchScore } : { kind: 'student', student, heard, matchScore };
}

/**
 * Try the recognizer's alternatives, but trust the first one: another reading
 * only replaces it when it is a complete "name + valid score" (or a fix of the
 * same kind), or when the first reading meant nothing. Otherwise a bare score
 * «خمسة» could lose to a name-like alternative «حمزة» and nothing gets written.
 */
export function interpret<T extends Named>(
  alternatives: string[],
  index: NameIndex<T>,
  ctx: InterpretContext = {},
): Interpretation<T> {
  const alts = alternatives.map((a) => a.trim()).filter(Boolean);
  if (!alts.length) return { kind: 'unknown', heard: '', reason: 'لم أسمع شيئاً' };
  let best = interpretOne(alts[0], index);
  for (const a of alts.slice(1)) {
    if (rank(best, ctx) <= 0.5) break;
    const r = interpretOne(a, index);
    const better = rank(r, ctx) < rank(best, ctx);
    const allowed = best.kind === 'unknown' || rank(r, ctx) <= 1 || r.kind === best.kind;
    if (better && allowed) best = r;
  }
  return best;
}

/** Below this name-match score a voice entry asks «واخا؟» instead of writing (noise can look like a name). */
export const SURE_MATCH = 0.8;
