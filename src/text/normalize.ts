/** Fold Arabic letter variants without touching punctuation/digits. */
export function foldArabic(s: string): string {
  return s
    .replace(/[ً-ْٰـ]/g, '') // tashkeel, superscript alef, tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

/** Arabic text normalization used by search/matching. */
export function normalizeArabic(s: string): string {
  return foldArabic(s)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
