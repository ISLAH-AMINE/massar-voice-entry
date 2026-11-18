/**
 * Darija / MSA / digit score parser. Pure functions, no DOM.
 *
 *   parseScore("خمسطاش ونص")      → { ok: true, value: 15.5 }
 *   parseScore("تلطاش لا ربع")    → { ok: true, value: 12.75 }
 *   parseScore("12 و ربع")         → { ok: true, value: 12.25 }
 *   parseScore("25")               → { ok: false, kind: 'invalid', error: … }
 *   parseScore("بوزيدي")            → { ok: false, kind: 'nomatch', error: … }
 *
 *   extractTrailingScore("بوزيدي عثمان خمسطاش ونص")
 *     → { name: "بوزيدي عثمان", score: { ok: true, value: 15.5 }, scoreText: "خمسطاش ونص" }
 */
import { foldArabic } from '../text/normalize';
import { checkScore } from './validate';

export type ParseResult =
  | { ok: true; value: number }
  | { ok: false; kind: 'nomatch' | 'invalid'; error: string };

// Keys are in folded form (أ→ا, ة→ه, ى→ي), so spelling variants collapse.
const WORDS: Record<string, number> = {};
const add = (v: number, ...ws: string[]) => ws.forEach((w) => (WORDS[w] = v));
add(0, 'صفر', 'زيرو', 'والو');
add(1, 'واحد', 'واحده');
add(2, 'جوج', 'زوج', 'اثنين', 'اتنين', 'اثنان', 'زوز');
add(3, 'تلاته', 'ثلاثه', 'تلاثه', 'تلاتا', 'ثلاث', 'تلات');
add(4, 'ربعه', 'اربعه', 'ربعا', 'اربع');
add(5, 'خمسه', 'خمسا', 'خمس');
add(6, 'سته', 'ستا', 'ست');
add(7, 'سبعه', 'سبعا', 'سبع');
add(8, 'تمنيه', 'ثمانيه', 'تمانيه', 'ثمنيه', 'تمنيا', 'ثمان');
add(9, 'تسعه', 'تسعا', 'تسع');
add(10, 'عشره', 'عشرا', 'عشر');
// Darija teens (after "تاش/ضاش/طاشر" variants are folded to "طاش"/"داش", see foldTeen)
add(11, 'حداش', 'احداش');
add(12, 'طناش', 'اطناش', 'اتناش', 'تناش', 'ثناش');
add(13, 'تلطاش', 'ثلطاش', 'تلتطاش', 'ثلثطاش');
add(14, 'ربعطاش', 'اربعطاش');
add(15, 'خمسطاش');
add(16, 'سطاش', 'ستطاش');
add(17, 'سبعطاش');
add(18, 'تمنطاش', 'ثمنطاش', 'تمانطاش');
add(19, 'تسعطاش');
add(20, 'عشرين', 'عشرون');

/** Units that may start an MSA teen ("خمسة عشر") — incl. forms only valid there. */
const MSA_TEEN_UNIT: Record<string, number> = { احد: 1, احدى: 1, احدي: 1, اثنا: 2, اثني: 2, اتنا: 2 };
const TEN_SUFFIX = new Set(['عشر', 'عشره']);
/** Tens, for student numbers above 20 (not valid as scores). */
const TENS: Record<string, number> = {
  عشرين: 20, عشرون: 20,
  تلاتين: 30, ثلاثين: 30, تلاثين: 30, ثلاثون: 30,
  ربعين: 40, اربعين: 40, اربعون: 40,
  خمسين: 50, خمسون: 50,
  ستين: 60, ستون: 60,
};

const PLUS_HALF = new Set(['نص', 'نصف']);
const QUARTER = new Set(['ربع']);
const MINUS = new Set(['الا', 'لا', 'غير', 'اللا']);
const FILLER_START = new Set(['نقطه', 'النقطه']);

function foldTeen(w: string): string {
  // خمستاش / خمسطاشر / حضاش → canonical
  return w.replace(/تاش(ر)?$/, 'طاش').replace(/طاشر$/, 'طاش').replace(/ضاش(ر)?$/, 'داش').replace(/داشر$/, 'داش');
}

const isKnown = (w: string) =>
  w in WORDS ||
  w in TENS || PLUS_HALF.has(w) || QUARTER.has(w) || MINUS.has(w) || TEN_SUFFIX.has(w) || w in MSA_TEEN_UNIT || w === 'و';

/** Normalize + tokenize a score phrase. Exported for tests. */
export function tokenizeScore(raw: string): string[] {
  let s = foldArabic(raw)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/(\d)\s*[٫,،.]\s*(\d)/g, '$1.$2')
    .replace(/(\d)(?=[^\d\s.])/g, '$1 ') // "12ونص" → "12 ونص"
    .replace(/(^|\s)و(?=\d)/g, '$1و ') // "و5" → "و 5"
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.\s/]/gu, ' ')
    // keep a dot only as a decimal point: Chrome ends phrases with "." («19.»)
    .replace(/\.(?!\d)|(?<!\d)\./g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // drop "/20", "على 20", "على عشرين", "من 20" at the end (على is folded to علي)
  s = s.replace(/\s*(\/|علي|من)\s*(20|عشرين)$/, '').trim();

  // teens split in two words by the recognizer: «خمس طاش» → «خمسطاش»
  s = s.replace(/(\S+) (طاش|تاش|طاشر|تاشر)(?= |$)/g, '$1$2');

  const out: string[] = [];
  for (let w of s.split(' ').filter(Boolean)) {
    w = foldTeen(w);
    if (isKnown(w) || /^\d/.test(w)) {
      out.push(w);
      continue;
    }
    // attached conjunction / negation: "ونص", "وربع", "وعشرين", "لاربع", "الاربع"
    const m = /^(و|الا|لا|غير)(.+)$/.exec(w);
    if (m && isKnown(foldTeen(m[2]))) {
      out.push(m[1], foldTeen(m[2]));
      continue;
    }
    out.push(w);
  }
  if (out.length > 1 && FILLER_START.has(out[0])) out.shift();
  return out;
}

const NOMATCH: ParseResult = { ok: false, kind: 'nomatch', error: 'لم أفهم النقطة' };

/** Parse a whole phrase as a score. Every token must be consumed. */
export function parseScore(raw: string): ParseResult {
  if (/[-−]\s*[\d٠-٩]/.test(raw)) return NOMATCH; // never silently drop a minus sign
  return parseTokens(tokenizeScore(raw));
}

function parseTokens(t: string[]): ParseResult {
  if (t.length === 0) return { ok: false, kind: 'nomatch', error: 'أدخل النقطة' };
  let i = 0;
  let value: number;
  let fractionAllowed = true;

  const tok = t[0];
  if (/^\d+(\.\d+)?$/.test(tok)) {
    value = parseFloat(tok);
    fractionAllowed = !tok.includes('.');
    i = 1;
  } else if (tok in MSA_TEEN_UNIT && TEN_SUFFIX.has(t[1])) {
    value = 10 + MSA_TEEN_UNIT[tok];
    i = 2;
  } else if (tok in WORDS) {
    value = WORDS[tok];
    i = 1;
    if (value >= 1 && value <= 9 && TEN_SUFFIX.has(t[1])) {
      value += 10; // MSA teen: "خمسة عشر"
      i = 2;
    } else if (value >= 1 && value <= 9 && t[1] === 'و' && t[2] && WORDS[t[2]] === 20) {
      value += 20; // "واحد و عشرين" → 21 (rejected later as out of range)
      i = 3;
    }
  } else {
    return NOMATCH;
  }

  // optional fraction
  if (i < t.length) {
    if (!fractionAllowed) return NOMATCH;
    const a = t[i];
    const b = t[i + 1];
    if (a === 'و' && b && PLUS_HALF.has(b)) {
      value += 0.5;
      i += 2;
    } else if (a === 'و' && b && QUARTER.has(b)) {
      value += 0.25;
      i += 2;
    } else if (MINUS.has(a) && b && QUARTER.has(b)) {
      value -= 0.25;
      i += 2;
    }
  }
  if (i !== t.length) return NOMATCH;

  const c = checkScore(value);
  return c.ok ? c : { ok: false, kind: 'invalid', error: c.error };
}

export interface Extracted {
  /** text before the score (the student name), trimmed; may be '' */
  name: string;
  /** the tokens recognized as the score, normalized */
  scoreText: string;
  score: ParseResult;
}

/**
 * Split "name … score" into its parts: the longest trailing run of tokens
 * that forms a score phrase. Returns null if the phrase doesn't end with a score.
 * An out-of-range number (e.g. "… 25") is still returned, with score.ok = false.
 */
export function extractTrailingScore(raw: string): Extracted | null {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  // Tokenization can split words ("ونص" → "و","نص"), so try suffixes over the
  // ORIGINAL words, longest first, and parse each suffix independently.
  for (let k = Math.min(words.length, 6); k >= 1; k--) {
    const tail = words.slice(words.length - k).join(' ');
    const r = parseScore(tail);
    if (r.ok || r.kind === 'invalid') {
      return { name: words.slice(0, words.length - k).join(' '), scoreText: tokenizeScore(tail).join(' '), score: r };
    }
  }
  return null;
}

/**
 * Parse a whole number 1–99 from already-tokenized words (see tokenizeScore):
 * digits, Darija/MSA units and teens, tens, and "unit و tens" (واحد و عشرين).
 * Every token must be used. Returns null otherwise.
 */
export function parseCount(t: string[]): number | null {
  if (!t.length) return null;
  if (t.length === 1 && /^\d{1,2}$/.test(t[0])) return +t[0] || null;
  if (t.length === 1) {
    const v = t[0] in WORDS ? WORDS[t[0]] : TENS[t[0]];
    return v ? v : null;
  }
  if (t.length === 2 && TEN_SUFFIX.has(t[1])) {
    const u = t[0] in MSA_TEEN_UNIT ? MSA_TEEN_UNIT[t[0]] : WORDS[t[0]];
    return u >= 1 && u <= 9 ? 10 + u : null; // خمسة عشر
  }
  if (t.length === 3 && t[1] === 'و' && TENS[t[2]] && TENS[t[2]] >= 20) {
    const u = WORDS[t[0]];
    return u >= 1 && u <= 9 ? TENS[t[2]] + u : null; // واحد و عشرين
  }
  return null;
}
