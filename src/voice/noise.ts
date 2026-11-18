/**
 * Helpers for noisy places (café, classroom). Pure functions.
 */
import { tokenizeScore } from '../score/darija';

/** An entry is short: «رقم 12 خمسطاش و نص» / «الاسم الكنية خمسطاش ونص». Longer = someone else talking. */
export const MAX_ENTRY_WORDS = 8;
/** Chrome gives 0..1 for final results (0 = not reported). Below this, the phrase was mostly noise. */
export const MIN_CONFIDENCE = 0.35;

/** Why a final result looks like background chatter, or null if it looks like an entry. */
export function chatterReason(text: string, confidence: number): string | null {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words > MAX_ENTRY_WORDS) return 'جملة طويلة — ليست إدخالاً';
  if (confidence > 0 && confidence < MIN_CONFIDENCE) return 'غير واضح';
  return null;
}

/**
 * «ونص», «و ربع», «لا ربع» said alone right after an entry: Chrome cut the
 * phrase before the fraction. Returns the correction to add, or null.
 */
export function fractionOnly(raw: string): number | null {
  const t = tokenizeScore(raw);
  if (t.length !== 2) return null;
  const [a, b] = t;
  if (a === 'و' && (b === 'نص' || b === 'نصف')) return 0.5;
  if (a === 'و' && b === 'ربع') return 0.25;
  if ((a === 'لا' || a === 'الا' || a === 'غير' || a === 'اللا') && b === 'ربع') return -0.25;
  return null;
}

/**
 * Background chatter keeps the recognizer from ever hearing a pause, so the
 * final result may never come. When the partial text already is a complete
 * entry and stays unchanged for `stableMs`, it is used as-is.
 */
export class Stabilizer {
  private text = '';
  private since = 0;
  constructor(
    private isComplete: (text: string) => boolean,
    private stableMs = 1000,
  ) {}

  feed(text: string, now: number) {
    const t = text.trim();
    if (t !== this.text) {
      this.text = t;
      this.since = now;
    }
  }

  /** The text to commit now, or null. Fires once per stable text. */
  check(now: number): string | null {
    if (!this.text || now - this.since < this.stableMs || !this.isComplete(this.text)) return null;
    const t = this.text;
    this.text = '';
    return t;
  }

  reset() {
    this.text = '';
  }
}
