/**
 * Range/quarter validation shared by the score parser.
 */
export type ScoreResult = { ok: true; value: number } | { ok: false; error: string };

export function checkScore(v: number): ScoreResult {
  if (!Number.isFinite(v)) return { ok: false, error: 'نقطة غير مفهومة' };
  if (v < 0 || v > 20) return { ok: false, error: `${v} خارج المجال 0–20` };
  if (Math.round(v * 4) !== v * 4) return { ok: false, error: `${v} ليست مضاعفاً لـ 0.25` };
  return { ok: true, value: v };
}

