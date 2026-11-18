/**
 * Student-by-number references: «رقم 5», «رقم تلاتة خمسطاش», «#12 15.5».
 * The number is the student's position in the class list (the # column).
 */
import { parseCount, parseScore, tokenizeScore, type Extracted } from '../score/darija';
import { foldArabic } from '../text/normalize';

export interface StudentRef {
  /** 1-based position in the class list */
  n: number;
  /** the "رقم 5" part, for display / as a name query */
  refText: string;
  /** score said after the number, if any */
  ex: Extracted | null;
}

const KEYWORDS = new Set(['رقم', 'الرقم', 'برقم', 'نمره', 'النمره', 'نمرو', 'نومرو', 'numero', 'num', 'no']);

/** Returns null when the text doesn't start with a number keyword (or "#"). */
export function parseStudentRef(raw: string): StudentRef | null {
  let text = foldArabic(raw).trim().toLowerCase();
  let hasKeyword = false;
  const hash = /^#\s*/.exec(text);
  if (hash) {
    text = text.slice(hash[0].length);
    hasKeyword = true;
  }
  const t = tokenizeScore(text);
  if (!hasKeyword) {
    if (!t.length || !KEYWORDS.has(t[0])) return null;
    t.shift();
  }
  if (!t.length) return null;

  // Try the shortest number first: «رقم خمسة عشرة» = student 5, score 10 (Darija),
  // «رقم واحد و عشرين خمسطاش» = student 21, score 15.
  for (let k = 1; k <= Math.min(3, t.length); k++) {
    const n = parseCount(t.slice(0, k));
    if (n === null) continue;
    const rest = t.slice(k);
    const refText = `رقم ${n}`;
    if (!rest.length) return { n, refText, ex: null };
    const score = parseScore(rest.join(' '));
    if (score.ok || score.kind === 'invalid') return { n, refText, ex: { name: refText, scoreText: rest.join(' '), score } };
  }
  return null;
}
