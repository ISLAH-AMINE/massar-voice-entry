/**
 * Voice commands. A command only fires when the WHOLE utterance is the command
 * («واخا», «رجع» …) — never when it's part of a name + score phrase.
 */
import { foldArabic } from '../text/normalize';

export type Command =
  | { kind: 'confirm' } // واخا
  | { kind: 'cancel' } // لا
  | { kind: 'pick'; index: number } // واحد / جوج / تلاتة — only while the picker is open
  | { kind: 'absent' } // غايب (not enabled)
  | { kind: 'undo' } // رجع
  | { kind: 'missing' } // شكون بقا
  | { kind: 'exam'; index: number } // فرض تاني … / الأنشطة (0-based exam column)
  | { kind: 'stop' } // حبس
  | { kind: 'export' }; // سجل

export interface CommandContext {
  pickOpen?: boolean;
}

export function normalizeCommand(raw: string): string {
  return foldArabic(raw)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const set = (...w: string[]) => new Set(w);
const CONFIRM = set('واخا', 'واخه', 'وخا', 'واكا', 'اوكي', 'اوك', 'ok', 'okay', 'نعم', 'اكد', 'تاكيد');
const CANCEL = set('لا', 'لا لا', 'لالا', 'الغي', 'الغاء', 'بلا', 'no');
const ABSENT = set('غايب', 'غياب', 'غايبه');
const UNDO = set('رجع', 'ارجع', 'رجعها', 'تراجع', 'رجع لور');
const STOP = set('حبس', 'حبس الاستماع', 'وقف', 'توقف', 'stop');
const EXPORT = set('سجل', 'سجل الملف', 'صدر', 'تصدير', 'صدر الملف');
const PICK: Record<string, number> = {
  واحد: 0, '1': 0, الاول: 0, لول: 0, اللول: 0,
  جوج: 1, زوج: 1, '2': 1, التاني: 1, الثاني: 1,
  تلاته: 2, ثلاثه: 2, تلاتا: 2, '3': 2, التالت: 2, الثالث: 2,
};
const MISSING = /^(ا?شكون|شكون لي|منو|من) (لي |اللي |الي )?(بقا|بقي|باقي|بقاو|بقات|مازال|ما زال)( ما ?دازش| ما ?عندوش)?$/;
const EXAM_ORD: [RegExp, number][] = [
  [/^(اول|لول|واحد|1)$/, 0],
  [/^(تاني|ثاني|جوج|زوج|2)$/, 1],
  [/^(تالت|ثالث|تلاته|ثلاثه|3)$/, 2],
];
const ACTIVITIES = /^(ال)?(انشطه|نشاط|نشاطات)( ال)?( ?مندمجه)?$/;

export function matchCommand(raw: string, ctx: CommandContext = {}): Command | null {
  const t = normalizeCommand(raw);
  if (!t) return null;
  if (ctx.pickOpen && t in PICK) return { kind: 'pick', index: PICK[t] };
  if (CONFIRM.has(t)) return { kind: 'confirm' };
  if (CANCEL.has(t)) return { kind: 'cancel' };
  if (ABSENT.has(t)) return { kind: 'absent' };
  if (UNDO.has(t)) return { kind: 'undo' };
  if (STOP.has(t)) return { kind: 'stop' };
  if (EXPORT.has(t)) return { kind: 'export' };
  if (MISSING.test(t)) return { kind: 'missing' };
  if (ACTIVITIES.test(t)) return { kind: 'exam', index: 3 };
  const fard = /^(ال)?فرض (ال|رقم )?(.+)$/.exec(t);
  if (fard) for (const [re, i] of EXAM_ORD) if (re.test(fard[3])) return { kind: 'exam', index: i };
  return null;
}

/** Single words that would be swallowed as commands if a student is called that. */
export const COMMAND_WORDS = ['واخا', 'لا', 'واحد', 'جوج', 'تلاتة', 'غايب', 'رجع', 'حبس', 'سجل', 'وقف', 'نعم'];
