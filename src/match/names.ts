/**
 * Fuzzy student-name matcher. Pure, no DOM.
 *
 * - Arabic normalization (أ/إ/آ→ا, ة→ه, ى→ي, no tashkeel/tatweel).
 * - Surname only, first name only, or both, in any order.
 * - Tolerates small errors (Levenshtein on letters + on a consonant skeleton,
 *   so "عتمان" ≈ "عثمان", "بوزدي" ≈ "بوزيدي").
 * - Latin / Arabizi input (3=ع, 7=ح, 9=ق, kh=خ, ch=ش, gh=غ …).
 * - Never guesses: if the best candidates are close, status = 'ambiguous'.
 */
import { normalizeArabic } from '../text/normalize';

export interface Named {
  name: string;
}
export interface Match<T extends Named = Named> {
  student: T;
  score: number; // 0..1
}
export interface MatchResult<T extends Named = Named> {
  status: 'none' | 'confident' | 'ambiguous';
  /** all candidates above MIN_SCORE, best first (for the typing dropdown) */
  ranked: Match<T>[];
  /** confident: [best]; ambiguous: the 2–3 close ones to choose from */
  options: Match<T>[];
  /** ambiguous only: how many other close candidates were left out of `options` */
  more: number;
}

export const MIN_SCORE = 0.6;
export const MARGIN = 0.1; // top must beat #2 by this much to be "confident"
const OPTION_BAND = 0.12; // candidates within this of the top are offered
const MAX_OPTIONS = 3;

// ---------- string helpers ----------
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}
const levSim = (a: string, b: string) => (a === b ? 1 : 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1));

/** Merge compound names so "عبد الرحمان" and "عبدالرحمان" compare equal. */
function tokens(normalized: string): string[] {
  const t = normalized.split(' ').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < t.length; i++) {
    if ((t[i] === 'عبد' || t[i] === 'ابو' || t[i] === 'abd' || t[i] === 'abdel' || t[i] === 'abou') && t[i + 1]) {
      out.push(t[i] + t[i + 1]);
      i++;
    } else out.push(t[i]);
  }
  return out;
}

/**
 * Consonant skeleton of an Arabic token: drops vowels/hamza and merges
 * letters that speech recognizers and people confuse.
 * `loose` also drops ع — only for Latin input, where people write "Omrane"
 * for عمران. For Arabic input ع is kept, otherwise عمران ≈ مروان.
 */
export function arabicSkeleton(w: string, loose = false): string {
  return w
    .replace(/ة/g, 'ه')
    .replace(/^ال(?=..)/, '')
    .replace(/ه$/, '')
    .replace(loose ? /[اويءع]/g : /[اويء]/g, '')
    .replace(/[طتث]/g, 'ت')
    .replace(/[صس]/g, 'س')
    .replace(/[ضدذ]/g, 'د')
    .replace(/[ظز]/g, 'ز')
    .replace(/[قكڭگ]/g, 'ك')
    .replace(/[حه]/g, 'ه')
    .replace(/(.)\1+/g, '$1'); // shadda / doubled letters
}

// Latin/Arabizi → Arabic letters. Digraphs first.
const LATIN_DIGRAPHS: [RegExp, string][] = [
  [/kh/g, 'خ'], [/ch/g, 'ش'], [/sh/g, 'ش'], [/gh/g, 'غ'], [/th/g, 'ث'], [/dh/g, 'ذ'],
  [/ou/g, 'و'], [/oo/g, 'و'], [/ee/g, 'ي'],
];
const LATIN: Record<string, string> = {
  b: 'ب', t: 'ت', j: 'ج', d: 'د', r: 'ر', z: 'ز', s: 'س', f: 'ف', q: 'ق', k: 'ك', l: 'ل',
  m: 'م', n: 'ن', h: 'ه', w: 'و', y: 'ي', g: 'ك', p: 'ب', v: 'ف', c: 'ك', x: 'كس',
  a: 'ا', i: 'ي', e: '', o: 'و', u: 'و',
  '3': 'ع', '7': 'ح', '9': 'ق', '5': 'خ', '2': 'ء', '8': 'ه', '6': 'ط',
};
export function latinToArabic(w: string): string {
  let s = w.toLowerCase();
  for (const [re, ar] of LATIN_DIGRAPHS) s = s.replace(re, ar);
  return [...s].map((ch) => LATIN[ch] ?? ch).join('');
}
const isLatin = (s: string) => /[a-z]/i.test(s);

// ---------- index ----------
interface Entry<T> {
  student: T;
  toks: string[];
  skel: string[]; // strict (keeps ع)
  skelLoose: string[]; // for Latin input
}

export class NameIndex<T extends Named> {
  private entries: Entry<T>[];

  constructor(students: T[]) {
    this.entries = students.map((student) => {
      const toks = tokens(normalizeArabic(student.name));
      return { student, toks, skel: toks.map((t) => arabicSkeleton(t)), skelLoose: toks.map((t) => arabicSkeleton(t, true)) };
    });
  }

  /** Student at 1-based position n in the class list (the # column). */
  at(n: number): T | undefined {
    return this.entries[n - 1]?.student;
  }

  /** Learned "heard text → student" mappings (misrecognized names). */
  private aliases = new Map<string, T>();
  static aliasKey(text: string): string {
    return normalizeArabic(text).toLowerCase();
  }
  addAlias(text: string, student: T) {
    const k = NameIndex.aliasKey(text);
    if (k) this.aliases.set(k, student);
  }

  match(query: string): MatchResult<T> {
    const aliased = this.aliases.get(NameIndex.aliasKey(query));
    if (aliased) {
      const m = { student: aliased, score: 1 };
      return { status: 'confident', ranked: [m], options: [m], more: 0 };
    }
    const q = tokens(normalizeArabic(query).toLowerCase());
    if (!q.length) return { status: 'none', ranked: [], options: [], more: 0 };
    const qa = q.map((t) => (isLatin(t) ? latinToArabic(t) : t));
    const qLatin = q.map(isLatin);
    const qskel = qa.map((t, i) => arabicSkeleton(t, qLatin[i]));

    const ranked: Match<T>[] = [];
    for (const e of this.entries) {
      const score = scoreEntry(qa, qskel, qLatin, e);
      if (score >= MIN_SCORE) ranked.push({ student: e.student, score });
    }
    ranked.sort((a, b) => b.score - a.score);

    if (!ranked.length) return { status: 'none', ranked, options: [], more: 0 };
    const top = ranked[0].score;
    const close = ranked.filter((m) => top - m.score < OPTION_BAND);
    const second = ranked[1]?.score ?? -1;
    if (top - second >= MARGIN) return { status: 'confident', ranked, options: [ranked[0]], more: 0 };
    return {
      status: 'ambiguous',
      ranked,
      options: close.slice(0, MAX_OPTIONS),
      more: Math.max(0, close.length - MAX_OPTIONS),
    };
  }

  /** Students whose name contains a token equal to `word` (normalized). */
  hasToken(word: string): T[] {
    const w = normalizeArabic(word);
    return this.entries.filter((e) => e.toks.includes(w)).map((e) => e.student);
  }
}

function tokenSim(q: string, qs: string, latin: boolean, n: string, ns: string): number {
  if (q === n) return 1;
  const strip = (w: string) => w.replace(/^ال(?=...)/, '');
  let best = 0;
  if (!latin) {
    best = Math.max(levSim(q, n), levSim(strip(q), strip(n)));
  } else {
    best = levSim(q, n) * 0.95; // transliteration incl. vowels
  }
  if (qs.length >= 2 && ns.length >= 2) best = Math.max(best, levSim(qs, ns) * (latin ? 0.97 : 0.92));
  // typed prefix ("خرب" → "بوزيدي")
  const pq = latin ? qs : strip(q);
  const pn = latin ? ns : strip(n);
  if (pq.length >= (latin ? 2 : 3) && pn.startsWith(pq)) best = Math.max(best, 0.75 + 0.2 * (pq.length / pn.length));
  return best;
}

function scoreEntry<T>(qa: string[], qskel: string[], qLatin: boolean[], e: Entry<T>): number {
  // similarity matrix query-token × name-token, then greedy 1-to-1 assignment
  const sims: [number, number, number][] = [];
  for (let i = 0; i < qa.length; i++)
    for (let j = 0; j < e.toks.length; j++) sims.push([tokenSim(qa[i], qskel[i], qLatin[i], e.toks[j], qLatin[i] ? e.skelLoose[j] : e.skel[j]), i, j]);
  sims.sort((a, b) => b[0] - a[0]);
  const qBest = new Array(qa.length).fill(0);
  const usedQ = new Set<number>();
  const usedN = new Set<number>();
  for (const [s, i, j] of sims) {
    if (usedQ.has(i) || usedN.has(j)) continue;
    usedQ.add(i);
    usedN.add(j);
    qBest[i] = s;
  }
  const mean = qBest.reduce((a, b) => a + b, 0) / qa.length;
  const matchedName = qBest.filter((s) => s >= 0.5).length;
  let score = mean * (0.8 + 0.2 * Math.min(1, matchedName / e.toks.length));
  if (Math.min(...qBest) < 0.5) score *= 0.5; // a spoken word that matches nothing
  return score;
}
