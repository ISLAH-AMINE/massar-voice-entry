import { parseMassar, exportMassar, type MassarFile, type Student } from './xlsx/massar';
import { normalizeArabic } from './text/normalize';
import { NameIndex, type MatchResult } from './match/names';
import { parseScore, extractTrailingScore, type Extracted } from './score/darija';
import { idbGet, idbSet } from './store';
import { Recognizer } from './voice/recognizer';
import { interpret, interpretOne } from './voice/interpret';
import { parseStudentRef } from './match/studentRef';
import { matchCommand, COMMAND_WORDS, type Command } from './voice/commands';

// ---------- state ----------
type Edits = Record<string, number | null>; // "G18" -> value (null = cleared)

interface ClassState {
  id: string; // file name
  fileName: string;
  bytes: Uint8Array;
  parsed: MassarFile;
  edits: Edits;
  dirty: boolean; // edits since last export
  aliases?: Record<string, number>; // learned misheard name → student row
}
interface UndoEntry {
  classId: string;
  ref: string;
  prev: number | null | undefined; // undefined = cell had no edit before
}

const S = {
  classes: [] as ClassState[],
  activeId: '',
  examCol: 'G',
  undo: [] as UndoEntry[],
  selRow: null as number | null, // currently targeted student row
  candidates: [] as Student[],
  candIdx: 0,
  showMissing: false,
  inline: null as Extracted | null, // score typed at the end of the search box
  live: null as MatchResult<Student> | null, // match for what's in the search box
  candTouched: false, // user moved through the dropdown with arrows = explicit choice
  pick: null as { options: Student[]; more: number; ex: Extracted | null; voice?: boolean; nameText?: string } | null,
  teach: null as { nameText: string; ex: Extracted | null } | null, // unknown spoken name waiting for a click // open disambiguation
  voiceTarget: null as Student | null, // named (or clicked) without a score: a bare spoken score goes here
  pending: null as Pending | null, // voice entry waiting for auto-commit / confirmation
  heard: [] as { text: string; outcome: string; cls: string }[], // recent utterances (newest first)
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = {
  tabs: $('tabs'),
  fileInput: $<HTMLInputElement>('fileInput'),
  drop: $('drop'),
  workspace: $('workspace'),
  meta: $('meta'),
  examPicker: $('examPicker'),
  undoBtn: $<HTMLButtonElement>('undoBtn'),
  exportBtn: $<HTMLButtonElement>('exportBtn'),
  progressBar: $('progressBar'),
  progressText: $('progressText'),
  missingToggle: $<HTMLButtonElement>('missingToggle'),
  missing: $('missing'),
  entry: $<HTMLFormElement>('entry'),
  search: $<HTMLInputElement>('search'),
  candidates: $('candidates'),
  score: $<HTMLInputElement>('score'),
  preview: $('preview'),
  pick: $('pick'),
  pending: $('pending'),
  teach: $('teach'),
  micBtn: $<HTMLButtonElement>('micBtn'),
  voice: $('voice'),
  interim: $('interim'),
  lastHeard: $('lastHeard'),
  heardLog: $('heardLog'),
  thead: document.querySelector('#table thead') as HTMLElement,
  tbody: document.querySelector('#table tbody') as HTMLElement,
  confirm: $<HTMLDialogElement>('confirm'),
  confirmText: $('confirmText'),
  toast: $('toast'),
};

const active = () => S.classes.find((c) => c.id === S.activeId);
const fmt = (v: number | null | undefined) => (v == null ? '' : v.toFixed(2));
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function current(c: ClassState, st: Student, col: string): number | null {
  const ref = col + st.row;
  return ref in c.edits ? c.edits[ref] : st.scores[col];
}

// ---------- persistence ----------
let saveTimer: number | undefined;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    idbSet('session', {
      classes: S.classes.map(({ id, fileName, bytes, edits, dirty, aliases }) => ({ id, fileName, bytes, edits, dirty, aliases })),
      activeId: S.activeId,
      examCol: S.examCol,
      undo: S.undo.slice(-200),
    }).catch((e) => toast('تعذر الحفظ التلقائي: ' + e, true));
  }, 250);
}

async function restore() {
  const data = await idbGet<any>('session').catch(() => undefined);
  if (!data?.classes?.length) return;
  for (const c of data.classes) {
    try {
      S.classes.push({ ...c, parsed: await parseMassar(c.bytes) });
    } catch (e) {
      console.error('restore failed for', c.fileName, e);
    }
  }
  S.activeId = S.classes.some((c) => c.id === data.activeId) ? data.activeId : S.classes[0]?.id ?? '';
  S.examCol = data.examCol ?? 'G';
  S.undo = data.undo ?? [];
}

// ---------- file loading ----------
async function addFiles(files: FileList | File[]) {
  for (const f of Array.from(files)) {
    if (!f.name.toLowerCase().endsWith('.xlsx')) {
      toast(`${f.name}: ليس ملف xlsx`, true);
      continue;
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    let parsed: MassarFile;
    try {
      parsed = await parseMassar(bytes);
    } catch (e: any) {
      toast(`${f.name}: ${e.message ?? e}`, true);
      continue;
    }
    const existing = S.classes.find((c) => c.id === f.name);
    if (existing) {
      if (Object.keys(existing.edits).length && !(await ask(`${f.name} مفتوح وفيه تعديلات غير مصدّرة. استبداله وحذف التعديلات؟`))) continue;
      Object.assign(existing, { bytes, parsed, edits: {}, dirty: false });
      S.undo = S.undo.filter((u) => u.classId !== f.name);
    } else {
      S.classes.push({ id: f.name, fileName: f.name, bytes, parsed, edits: {}, dirty: false });
    }
    S.activeId = f.name;
    warnCommandCollisions(S.classes.find((x) => x.id === f.name)!);
  }
  S.selRow = null;
  save();
  render();
}

async function closeClass(id: string) {
  const c = S.classes.find((x) => x.id === id);
  if (!c) return;
  if (c.dirty && !(await ask(`${c.parsed.className || c.fileName}: تعديلات غير مصدّرة. إغلاق على أي حال؟`))) return;
  S.classes = S.classes.filter((x) => x.id !== id);
  S.undo = S.undo.filter((u) => u.classId !== id);
  if (S.activeId === id) S.activeId = S.classes[0]?.id ?? '';
  save();
  render();
}

// ---------- commit / undo ----------
async function commit(st: Student, value: number | null, preConfirmed = false): Promise<boolean> {
  const c = active()!;
  const col = S.examCol;
  const ref = col + st.row;
  const old = current(c, st, col);
  if (old === value) {
    toast(`${st.name}: نفس النقطة (${fmt(value)})`);
    return true;
  }
  if (old !== null && !preConfirmed && !(await ask(`${st.name}<br><span class="mono">${fmt(old)} ← ${fmt(value)}</span><br>استبدال النقطة الموجودة؟`)))
    return false;
  S.undo.push({ classId: c.id, ref, prev: ref in c.edits ? c.edits[ref] : undefined });
  setEdit(c, st, col, value);
  toast(`✓ ${st.name} → ${fmt(value)}`);
  return true;
}

function setEdit(c: ClassState, st: Student, col: string, value: number | null | undefined) {
  const ref = col + st.row;
  if (value === undefined || value === st.scores[col]) delete c.edits[ref];
  else c.edits[ref] = value;
  c.dirty = true;
  S.selRow = st.row;
  save();
  render();
  scrollToRow(st.row);
}

function undo() {
  const u = S.undo.pop();
  if (!u) return toast('لا شيء للتراجع');
  const c = S.classes.find((x) => x.id === u.classId);
  const row = +u.ref.replace(/^[A-Z]+/, '');
  const col = u.ref.replace(/\d+$/, '');
  const st = c?.parsed.students.find((s) => s.row === row);
  if (!c || !st) return undo();
  S.activeId = c.id;
  S.examCol = col;
  setEdit(c, st, col, u.prev);
  toast(`↶ ${st.name} → ${fmt(current(c, st, col)) || 'فارغ'}`);
}

// ---------- voice: write immediately; only an overwrite waits for confirmation ----------
interface Pending {
  classId: string;
  examCol: string;
  student: Student;
  value: number;
  old: number | null;
  needsConfirm: boolean; // always true: only overwrites of an existing score wait
  heard: string; // what was said, for the log
  timer?: number;
}

function startPending(st: Student, value: number) {
  const c = active()!;
  flushPending();
  S.voiceTarget = null;
  selectStudent(st, false);
  el.search.value = '';
  const old = current(c, st, S.examCol);
  if (old === value) {
    logHeard(`${st.name}: نفس النقطة ${fmt(value)}`, 'muted');
    toast(`${st.name}: نفس النقطة (${fmt(value)})`);
    return;
  }
  S.pending = { classId: c.id, examCol: S.examCol, student: st, value, old, needsConfirm: old !== null, heard: el.lastHeard.textContent || '' };
  if (old === null) commitPending(); // empty cell → write right away (undo with ↶ / Ctrl+Z)
  else renderPending(); // existing score → ask first
}

async function commitPending() {
  const p = S.pending;
  if (!p) return;
  clearTimeout(p.timer);
  S.pending = null;
  renderPending();
  // the user may have switched tab/exam before confirming: write where it was heard
  if (S.activeId !== p.classId || S.examCol !== p.examCol) {
    S.activeId = p.classId;
    S.examCol = p.examCol;
    render();
  }
  if (await commit(p.student, p.value, true)) logHeard(`${p.student.name} → ${fmt(p.value)}`, 'ok', p.heard);
}

function cancelPending(reason = 'أُلغي') {
  const p = S.pending;
  if (!p) return;
  clearTimeout(p.timer);
  S.pending = null;
  renderPending();
  logHeard(`${p.student.name} → ${fmt(p.value)} (${reason})`, 'muted', p.heard);
  toast(`✕ ${reason}: ${p.student.name}`);
}

/** A new utterance arrived: an unconfirmed overwrite is dropped. */
function flushPending() {
  const p = S.pending;
  if (!p) return;
  if (p.needsConfirm) cancelPending('لم يُؤكَّد');
  else commitPending();
}

function renderPending() {
  const p = S.pending;
  if (!p) {
    el.pending.hidden = true;
    el.pending.innerHTML = '';
    return;
  }
  el.pending.hidden = false;
  el.pending.className = 'pending confirm';
  el.pending.innerHTML =
    `<span>استبدال؟ <b>${esc(p.student.name)}</b> <span class="mono">${fmt(p.old)} ← <b>${fmt(p.value)}</b></span></span>` +
    `<button type="button" class="btn primary small" data-act="ok">تأكيد ↵</button>` +
    `<button type="button" class="btn ghost small" data-act="cancel">إلغاء Esc</button>`;
}

/** Student (and maybe score) resolved from speech. */
function applyVoiceEntry(st: Student, ex: Extracted | null) {
  if (!ex) {
    S.voiceTarget = st;
    selectStudent(st, false);
    el.search.value = '';
    logHeard(`${st.name} — قل النقطة`, 'muted');
    return;
  }
  if (!ex.score.ok) {
    selectStudent(st, false);
    el.search.value = '';
    logHeard(`${st.name}: ${ex.score.error}`, 'err');
    toast(`${st.name}: ${ex.score.error}`, true);
    return;
  }
  startPending(st, ex.score.value);
}

function handleUtterance(alternatives: string[]) {
  const c = active();
  if (!c) return;
  el.voice.hidden = false;
  el.interim.textContent = '';
  liveRow = null;
  el.tbody.querySelector('tr.live')?.classList.remove('live');
  // A command only counts when it is the WHOLE utterance (first reading),
  // or when the first reading means nothing else and another reading is a command.
  const cmd0 = matchCommand(alternatives[0] ?? '', { pickOpen: !!S.pick });
  if (cmd0) {
    el.lastHeard.textContent = alternatives[0];
    return runCommand(cmd0);
  }
  const r = interpret(alternatives, nameIndex(c), { awaitingScore: !!S.voiceTarget });
  if (r.kind === 'unknown') {
    for (const a of alternatives.slice(1)) {
      const cmd = matchCommand(a, { pickOpen: !!S.pick });
      if (cmd) {
        el.lastHeard.textContent = a;
        return runCommand(cmd);
      }
    }
  }
  const heard = r.heard || alternatives[0] || '';
  el.lastHeard.textContent = heard;
  if (r.kind !== 'scoreOnly') closePick(); // a new name abandons an open choice
  closeTeach();

  switch (r.kind) {
    case 'entry':
      return applyVoiceEntry(r.student, r.ex);
    case 'student':
      flushPending();
      return applyVoiceEntry(r.student, null);
    case 'scoreOnly': {
      // "خمسطاش" right after a name, or to answer an open picker later
      const st = S.voiceTarget;
      if (S.pick || !st) {
        logHeard(`لمن هذه النقطة؟`, 'err');
        return toast('قل اسم التلميذ', true);
      }
      return applyVoiceEntry(st, r.ex);
    }
    case 'pick':
      flushPending();
      openPick(r.options, r.more, r.ex, true, r.nameText);
      return logHeard(`أسماء متقاربة — اختر`, 'warn');
    case 'unknown':
      logHeard(r.reason, 'err');
      if (r.nameText) return openTeach(r.nameText, r.ex ?? null);
      return toast(r.reason, true);
  }
}

/** On load: a student whose name contains a command word («رجع», «لا» …) can't be called by that word alone. */
function warnCommandCollisions(c: ClassState): string[] {
  const idx = nameIndex(c);
  const hits: string[] = [];
  for (const w of COMMAND_WORDS) for (const st of idx.hasToken(w)) hits.push(`«${w}» ⟵ ${st.name}`);
  if (hits.length) {
    const msg = `${c.parsed.className}: كلمات أوامر في أسماء التلاميذ — ${hits.join('، ')}. قل الاسم الكامل أو الرقم.`;
    toast(msg, true);
    console.warn(msg);
  }
  return hits;
}

function runCommand(cmd: Command) {
  const c = active()!;
  const done = (msg: string, cls = 'ok') => {
    logHeard(msg, cls);
    toast(msg, cls === 'err');
  };
  switch (cmd.kind) {
    case 'confirm':
      if (S.pending) return commitPending();
      return done('لا شيء للتأكيد', 'muted');
    case 'cancel':
      if (S.pending) return cancelPending();
      if (S.pick) {
        closePick();
        return done('أُلغي الاختيار', 'muted');
      }
      if (S.teach) {
        closeTeach();
        return done('أُلغي', 'muted');
      }
      return done('لا شيء للإلغاء', 'muted');
    case 'pick':
      if (!S.pick || cmd.index >= S.pick.options.length) return done(`لا يوجد اختيار ${cmd.index + 1}`, 'err');
      return choosePick(cmd.index);
    case 'absent':
      return done('الغياب غير مفعّل', 'err');
    case 'undo':
      logHeard('↶ تراجع', 'ok');
      return undo();
    case 'missing': {
      const miss = missingStudents(c);
      S.showMissing = true;
      renderProgress();
      if (!miss.length) return done('الكل مُدخل ✓');
      const names = miss.slice(0, 4).map((s) => s.name).join('، ');
      return done(`بقي ${miss.length}: ${names}${miss.length > 4 ? '…' : ''}`, 'warn');
    }
    case 'exam': {
      const exam = c.parsed.exams[cmd.index];
      if (!exam) return done('هذا الفرض غير موجود', 'err');
      flushPending();
      closePick();
      S.examCol = exam.col;
      S.voiceTarget = null;
      save();
      render();
      return done(`← ${exam.label}`);
    }
    case 'stop':
      recognizer?.stop();
      return done('■ توقف الاستماع', 'muted');
    case 'export':
      logHeard('⬇ تصدير', 'ok');
      return void exportActive();
  }
}

/**
 * While you are still speaking: highlight the student the partial transcript
 * already points to (nothing is written until the final result).
 */
let liveRow: number | null = null;
function liveHighlight(text: string) {
  const c = active();
  if (!c || !text.trim()) return;
  const r = interpretOne(text, nameIndex(c));
  const st = r.kind === 'entry' || r.kind === 'student' ? r.student : null;
  if (!st || st.row === liveRow) return;
  el.tbody.querySelector('tr.live')?.classList.remove('live');
  liveRow = st.row;
  el.tbody.querySelector(`tr[data-row="${st.row}"]`)?.classList.add('live');
  scrollToRow(st.row);
}

function logHeard(outcome: string, cls: string, text = el.lastHeard.textContent || '') {
  S.heard.unshift({ text, outcome, cls });
  S.heard.length = Math.min(S.heard.length, 3);
  el.heardLog.innerHTML = S.heard
    .map((h) => `<li class="${h.cls}"><span class="heard">«${esc(h.text)}»</span> ${esc(h.outcome)}</li>`)
    .join('');
}

let recognizer: Recognizer | null = null;
function toggleMic() {
  if (!Recognizer.supported()) return toast('التعرف على الصوت غير متوفر — استعمل Chrome أو Edge', true);
  if (!recognizer) {
    recognizer = new Recognizer('ar-MA');
    recognizer.onInterim = (t) => {
      el.interim.textContent = t;
      liveHighlight(t);
    };
    recognizer.onFinal = handleUtterance;
    recognizer.onState = (state, msg) => {
      el.micBtn.classList.toggle('on', state === 'listening' || (state === 'error' && recognizer!.listening));
      el.micBtn.textContent = recognizer!.listening ? '■ إيقاف' : '🎤 استماع';
      el.voice.hidden = !recognizer!.listening && !S.heard.length;
      if (msg) toast(msg, true);
    };
  }
  if (recognizer.listening) recognizer.stop();
  else {
    recognizer.start();
    el.voice.hidden = false;
    el.micBtn.textContent = '■ إيقاف';
  }
}

// ---------- export ----------
async function exportActive() {
  const c = active();
  if (!c) return;
  try {
    const edits = new Map(Object.entries(c.edits));
    const out = await exportMassar(c.bytes, edits);
    const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = c.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    c.dirty = false;
    save();
    render();
    toast(`⬇ ${c.fileName} (${edits.size} تعديل)`);
  } catch (e: any) {
    toast('فشل التصدير: ' + (e.message ?? e), true);
  }
}

// ---------- name matching ----------
const indexes = new WeakMap<MassarFile, NameIndex<Student>>();
function nameIndex(c: ClassState): NameIndex<Student> {
  let idx = indexes.get(c.parsed);
  if (!idx) {
    indexes.set(c.parsed, (idx = new NameIndex(c.parsed.students)));
    for (const [text, row] of Object.entries(c.aliases ?? {})) {
      const st = c.parsed.students.find((s) => s.row === row);
      if (st) idx.addAlias(text, st);
    }
  }
  return idx;
}

/** Remember that `heardText` means `st` in this class (saved with the session). */
function learnAlias(c: ClassState, heardText: string, st: Student) {
  const key = NameIndex.aliasKey(heardText);
  if (!key || key === NameIndex.aliasKey(st.name)) return;
  c.aliases = { ...(c.aliases ?? {}), [key]: st.row };
  nameIndex(c).addAlias(heardText, st);
  save();
  logHeard(`تعلّمت: «${heardText}» = ${st.name}`, 'ok', heardText);
}

function matchName(q: string): MatchResult<Student> | null {
  const c = active();
  if (!c) return null;
  const ref = parseStudentRef(q); // «رقم 5» / «#5»
  if (ref) {
    const st = nameIndex(c).at(ref.n);
    if (!st) return { status: 'none', ranked: [], options: [], more: 0 };
    const m = { student: st, score: 1 };
    return { status: 'confident', ranked: [m], options: [m], more: 0 };
  }
  if (!normalizeArabic(q)) return null;
  return nameIndex(c).match(q);
}

// ---------- teach: an unknown spoken name → click the right student once ----------
function openTeach(nameText: string, ex: Extracted | null) {
  S.teach = { nameText, ex };
  renderTeach();
}
function closeTeach() {
  if (!S.teach) return;
  S.teach = null;
  renderTeach();
}
function renderTeach() {
  const t = S.teach;
  el.teach.hidden = !t;
  el.teach.innerHTML = t
    ? `<span>لم أجد «<b>${esc(t.nameText)}</b>»${t.ex?.score.ok ? ` → <b class="mono">${fmt(t.ex.score.value)}</b>` : ''} — انقر على التلميذ المقصود لأتذكّره</span>` +
      `<button type="button" class="btn ghost small" data-act="cancel">إلغاء Esc</button>`
    : '';
}
function finishTeach(st: Student) {
  const t = S.teach!;
  const c = active()!;
  closeTeach();
  learnAlias(c, t.nameText, st);
  applyVoiceEntry(st, t.ex);
}

/**
 * Resolve "name [score]" without guessing. Used by Enter in the search box
 * (and by voice input in step 4).
 *  - confident → select (and commit if a score was given)
 *  - ambiguous → open the numbered picker and wait
 */
function resolveEntry(nameQuery: string, ex: Extracted | null) {
  const r = matchName(nameQuery);
  if (!r || r.status === 'none') {
    toast(`لم أجد «${nameQuery}»`, true);
    return;
  }
  if (r.status === 'ambiguous') {
    openPick(r.options.map((m) => m.student), r.more, ex);
    return;
  }
  const st = r.options[0].student;
  selectStudent(st, !ex);
  if (ex) commitInline(st, ex);
}

function openPick(options: Student[], more: number, ex: Extracted | null, voice = false, nameText?: string) {
  S.pick = { options, more, ex, voice, nameText };
  S.candidates = [];
  renderCandidates();
  renderPick();
  renderTable();
  updatePreview();
  scrollToRow(S.pick.options[0].row);
}

function closePick() {
  if (!S.pick) return;
  S.pick = null;
  renderPick();
  renderTable();
}

function choosePick(i: number) {
  const p = S.pick;
  const st = p?.options[i];
  if (!p || !st) return;
  closePick();
  // (no alias learning here: «بوزيدي» is legitimately ambiguous between twins)
  if (p.voice) return applyVoiceEntry(st, p.ex);
  selectStudent(st, !p.ex);
  if (p.ex) commitInline(st, p.ex);
}

function renderPick() {
  const p = S.pick;
  const c = active();
  if (!p || !c) {
    el.pick.hidden = true;
    el.pick.innerHTML = '';
    return;
  }
  const score = p.ex?.score.ok ? ` → <span class="mono ok">${fmt(p.ex.score.value)}</span>` : '';
  el.pick.hidden = false;
  el.pick.innerHTML =
    `<span class="pick-q">أي تلميذ؟${score}</span>` +
    p.options
      .map((st, i) => {
        const cur = current(c, st, S.examCol);
        return `<button type="button" data-pick="${i}"><span class="num">${i + 1}</span> ${esc(st.name)}${cur !== null ? ` <span class="mono muted">${fmt(cur)}</span>` : ''}</button>`;
      })
      .join('') +
    (p.more ? `<span class="muted">+${p.more} آخرين — أضف جزءاً من الاسم</span>` : '') +
    `<span class="muted small">اضغط 1–${p.options.length} · Esc للإلغاء</span>`;
}

function selectStudent(st: Student, focusScore = true) {
  S.selRow = st.row;
  el.search.value = st.name;
  S.candidates = [];
  renderCandidates();
  renderTable();
  scrollToRow(st.row);
  updatePreview();
  if (focusScore) {
    el.score.focus();
    el.score.select();
  }
}

function updatePreview() {
  const c = active();
  // inline "name score" in the search box → preview against the top candidate
  const inlineSt = S.inline ? S.candidates[S.candIdx] : undefined;
  const st = inlineSt ?? c?.parsed.students.find((s) => s.row === S.selRow);
  if (S.pick) {
    el.preview.innerHTML = '';
    return;
  }
  if (c && S.live?.status === 'ambiguous' && !S.candTouched && !S.selRow) {
    el.preview.innerHTML = `<span class="warn">⚠ أسماء متقاربة — Enter لعرض الاختيارات، أو اختر بالأسهم</span>`;
    return;
  }
  if (!c || !st) {
    el.preview.innerHTML = S.inline && !S.candidates.length ? `<span class="err">لا يوجد تلميذ بهذا الاسم</span>` : '';
    return;
  }
  const old = current(c, st, S.examCol);
  const raw = inlineSt ? '' : el.score.value;
  let html = `<b>${esc(st.name)}</b>`;
  if (inlineSt) {
    const r = S.inline!.score;
    html += r.ok
      ? ` → <span class="ok mono">${fmt(r.value)}</span>${old !== null ? ` <span class="muted">(الحالية ${fmt(old)})</span>` : ''} <span class="muted">· Enter للتسجيل</span>`
      : ` — <span class="err">${esc(r.error)}</span>`;
  } else if (raw.trim()) {
    const r = parseScore(raw);
    html += r.ok
      ? ` → <span class="ok mono">${fmt(r.value)}</span>${old !== null ? ` <span class="muted">(الحالية ${fmt(old)})</span>` : ''}`
      : ` — <span class="err">${esc(r.error)}</span>`;
  } else if (old !== null) html += ` <span class="muted">(الحالية ${fmt(old)})</span>`;
  el.preview.innerHTML = html;
}

// ---------- rendering ----------
function render() {
  const c = active();
  el.drop.hidden = !!c;
  el.workspace.hidden = !c;
  renderTabs();
  if (!c) return;
  if (!c.parsed.exams.some((e) => e.col === S.examCol)) S.examCol = c.parsed.exams[0].col;
  el.meta.innerHTML = `<b>${esc(c.parsed.className)}</b> · ${esc(c.parsed.subject)} · ${c.parsed.students.length} تلميذ`;
  el.examPicker.innerHTML = c.parsed.exams
    .map((e) => `<button data-col="${e.col}" class="${e.col === S.examCol ? 'active' : ''}">${esc(e.label)}</button>`)
    .join('');
  el.undoBtn.disabled = S.undo.length === 0;
  renderProgress();
  renderTable();
  renderPick();
  updatePreview();
}

function renderTabs() {
  el.tabs.innerHTML = S.classes
    .map(
      (c) =>
        `<div class="tab ${c.id === S.activeId ? 'active' : ''}" data-id="${esc(c.id)}" title="${esc(c.fileName)}">` +
        (c.dirty ? '<span class="dot" title="تعديلات غير مصدّرة"></span>' : '') +
        `${esc(c.parsed.className || c.fileName)}<span class="x" data-close="${esc(c.id)}">×</span></div>`,
    )
    .join('');
}

function missingStudents(c: ClassState) {
  return c.parsed.students.filter((st) => current(c, st, S.examCol) === null);
}

function renderProgress() {
  const c = active()!;
  const total = c.parsed.students.length;
  const miss = missingStudents(c);
  const done = total - miss.length;
  el.progressBar.style.width = `${(100 * done) / total}%`;
  el.progressText.textContent = `${done}/${total}`;
  el.missingToggle.textContent = miss.length ? `بدون نقطة (${miss.length}) ${S.showMissing ? '▴' : '▾'}` : 'الكل مُدخل ✓';
  el.missingToggle.disabled = !miss.length;
  el.missing.hidden = !S.showMissing || !miss.length;
  el.missing.innerHTML = miss.map((st) => `<button data-row="${st.row}">${esc(st.name)}</button>`).join('');
}

function renderTable() {
  const c = active();
  if (!c) return;
  const exams = c.parsed.exams;
  el.thead.innerHTML =
    '<tr><th>#</th><th>الاسم</th>' +
    exams.map((e) => `<th class="${e.col === S.examCol ? 'active-col' : ''}" style="text-align:center">${esc(e.label)}</th>`).join('') +
    '</tr>';
  el.tbody.innerHTML = c.parsed.students
    .map((st, i) => {
      const tds = exams
        .map((e) => {
          const ref = e.col + st.row;
          const cls = ['score', 'mono', e.col === S.examCol ? 'active-col' : '', ref in c.edits ? 'edited' : ''].join(' ');
          return `<td class="${cls}">${fmt(current(c, st, e.col))}</td>`;
        })
        .join('');
      const pickNo = S.pick ? S.pick.options.indexOf(st) + 1 : 0;
      const rowCls = st.row === S.selRow ? 'hl' : pickNo ? 'opt' : '';
      return `<tr data-row="${st.row}" class="${rowCls}" ${pickNo ? `data-pickno="${pickNo}"` : ''}><td class="idx">${pickNo ? `<span class="pickno">${pickNo}</span>` : i + 1}</td><td>${esc(st.name)}</td>${tds}</tr>`;
    })
    .join('');
}

function renderCandidates() {
  if (!S.candidates.length) {
    el.candidates.hidden = true;
    return;
  }
  const c = active()!;
  el.candidates.hidden = false;
  el.candidates.innerHTML = S.candidates
    .map(
      (st, i) =>
        `<li data-row="${st.row}" class="${i === S.candIdx ? 'sel' : ''}"><span><span class="num">${i + 1}.</span> ${esc(st.name)}</span><span class="mono muted">${fmt(current(c, st, S.examCol))}</span></li>`,
    )
    .join('');
}

function scrollToRow(row: number) {
  // center the row in the visible area BELOW the sticky controls (scrollIntoView would hide it under them)
  requestAnimationFrame(() => {
    const tr = el.tbody.querySelector<HTMLElement>(`tr[data-row="${row}"]`);
    const controls = document.querySelector<HTMLElement>('.controls');
    if (!tr || !controls) return;
    const ctrlBottom = controls.getBoundingClientRect().bottom;
    const r = tr.getBoundingClientRect();
    const visibleMid = ctrlBottom + (window.innerHeight - ctrlBottom) / 2;
    window.scrollTo({ top: window.scrollY + r.top + r.height / 2 - visibleMid, behavior: 'auto' }); // instant: smooth scrolling felt slow
  });
}

/** "name + score" typed in the search box, Enter pressed */
async function commitInline(st: Student, ex: Extracted) {
  S.inline = null;
  if (!ex.score.ok) {
    toast(ex.score.error, true);
    el.score.value = ex.scoreText;
    el.score.focus();
    updatePreview();
    return;
  }
  if (await commit(st, ex.score.value)) {
    el.search.value = el.score.value = '';
    updatePreview();
  }
  el.search.focus();
}

// ---------- small UI helpers ----------
let toastTimer: number | undefined;
function toast(msg: string, err = false) {
  el.toast.textContent = msg;
  el.toast.className = 'toast' + (err ? ' err' : '');
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.toast.hidden = true), err ? 5000 : 2200);
}

let pendingAsk: ((ok: boolean) => void) | null = null;
function ask(html: string): Promise<boolean> {
  pendingAsk?.(false); // never leave an older question dangling
  return new Promise((resolve) => {
    pendingAsk = resolve;
    el.confirmText.innerHTML = html;
    el.confirm.showModal();
  });
}
function answerAsk(ok: boolean) {
  const r = pendingAsk;
  pendingAsk = null;
  if (el.confirm.open) el.confirm.close();
  r?.(ok);
}
// Resolve synchronously from the clicked button (the dialog 'close' event can be delayed)
el.confirm.querySelector('form')!.addEventListener('submit', (e) => {
  e.preventDefault();
  answerAsk((e.submitter as HTMLButtonElement | null)?.value === 'ok');
});
el.confirm.addEventListener('cancel', (e) => {
  e.preventDefault();
  answerAsk(false); // Escape
});

// ---------- events ----------
el.fileInput.addEventListener('change', () => {
  if (el.fileInput.files) addFiles(el.fileInput.files);
  el.fileInput.value = '';
});
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
});

el.tabs.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const close = t.closest<HTMLElement>('[data-close]');
  if (close) return void closeClass(close.dataset.close!);
  const tab = t.closest<HTMLElement>('[data-id]');
  if (tab) {
    S.activeId = tab.dataset.id!;
    S.selRow = null;
    S.pick = null;
    S.voiceTarget = null;
    el.search.value = el.score.value = '';
    save();
    render();
  }
});

el.examPicker.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-col]');
  if (!b) return;
  S.examCol = b.dataset.col!;
  save();
  render();
});

el.missingToggle.addEventListener('click', () => {
  S.showMissing = !S.showMissing;
  renderProgress();
});
el.missing.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-row]');
  const st = active()?.parsed.students.find((s) => s.row === +b?.dataset.row!);
  if (st) {
    S.voiceTarget = st;
    selectStudent(st);
  }
});

el.tbody.addEventListener('click', (e) => {
  const tr = (e.target as HTMLElement).closest<HTMLElement>('tr[data-row]');
  const st = active()?.parsed.students.find((s) => s.row === +tr?.dataset.row!);
  if (!st) return;
  if (S.teach) return finishTeach(st); // "this is who I meant"
  S.voiceTarget = st;
  selectStudent(st);
});
el.teach.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-act="cancel"]')) closeTeach();
});

el.search.addEventListener('input', () => {
  S.selRow = null;
  closePick();
  // «رقم 5 15» / «#5 15»: the number picks the student, the rest is the score
  const ref = parseStudentRef(el.search.value);
  const ex = ref ? ref.ex : extractTrailingScore(el.search.value);
  S.inline = ref ? (ref.ex ? { ...ref.ex, name: ref.refText } : null) : ex && ex.name ? ex : null;
  S.live = matchName(S.inline ? S.inline.name : el.search.value);
  S.candidates = (S.live?.ranked ?? []).slice(0, 8).map((m) => m.student);
  S.candIdx = 0;
  S.candTouched = false;
  renderCandidates();
  renderTable();
  if (S.candidates[0]) scrollToRow(S.candidates[0].row);
  updatePreview();
});
el.search.addEventListener('keydown', (e) => {
  if (S.pick) return; // picker keys are handled globally
  if (!S.candidates.length) {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (S.selRow) el.score.focus();
      else if (el.search.value.trim()) resolveEntry(S.inline ? S.inline.name : el.search.value, S.inline);
    }
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    S.candIdx = (S.candIdx + (e.key === 'ArrowDown' ? 1 : -1) + S.candidates.length) % S.candidates.length;
    S.candTouched = true;
    renderCandidates();
    updatePreview();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const inline = S.inline;
    if (S.candTouched) {
      // explicit choice from the dropdown
      const st = S.candidates[S.candIdx];
      selectStudent(st, !inline);
      if (inline) commitInline(st, inline);
    } else {
      resolveEntry(inline ? inline.name : el.search.value, inline);
    }
  } else if (e.key === 'Escape') {
    S.candidates = [];
    renderCandidates();
  } else if (/^[1-9]$/.test(e.key) && e.altKey) {
    const st = S.candidates[+e.key - 1];
    if (st) {
      e.preventDefault();
      selectStudent(st);
    }
  }
});
el.candidates.addEventListener('mousedown', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-row]');
  const st = S.candidates.find((s) => s.row === +li?.dataset.row!);
  if (st) {
    e.preventDefault();
    selectStudent(st);
  }
});
el.search.addEventListener('blur', () => setTimeout(() => ((S.candidates = []), renderCandidates()), 150));

el.score.addEventListener('input', updatePreview);
el.entry.addEventListener('submit', async (e) => {
  e.preventDefault();
  const st = active()?.parsed.students.find((s) => s.row === S.selRow);
  if (!st) {
    toast('اختر تلميذاً أولاً', true);
    el.search.focus();
    return;
  }
  const r = parseScore(el.score.value);
  if (!r.ok) {
    toast(r.error, true);
    el.score.select();
    return;
  }
  if (await commit(st, r.value)) {
    el.search.value = el.score.value = '';
    updatePreview();
    el.search.focus();
  }
});

el.undoBtn.addEventListener('click', undo);
el.micBtn.addEventListener('click', toggleMic);
el.pending.addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'ok') commitPending();
  else if (act === 'cancel') cancelPending();
});
// Pending voice entry: Enter = commit now, Esc = cancel (capture phase, before inputs see the key)
window.addEventListener(
  'keydown',
  (e) => {
    if (!S.pending || el.confirm.open) return;
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Enter') commitPending();
      else cancelPending();
    }
  },
  true,
);
el.exportBtn.addEventListener('click', exportActive);

el.pick.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-pick]');
  if (b) choosePick(+b.dataset.pick!);
});

window.addEventListener('keydown', (e) => {
  if (S.teach && e.key === 'Escape') {
    e.preventDefault();
    return closeTeach();
  }
  if (S.pick && !el.confirm.open) {
    const n = '١٢٣٤٥٦٧٨٩'.indexOf(e.key) + 1 || +e.key;
    if (n >= 1 && n <= S.pick.options.length && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      return choosePick(n - 1);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closePick();
      el.search.focus();
      return;
    }
  }
  const t = e.target as HTMLElement;
  const typing = (t instanceof HTMLInputElement && t.value !== '') || el.confirm.open;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
    e.preventDefault();
    undo();
  }
});
window.addEventListener('beforeunload', (e) => {
  if (S.classes.some((c) => c.dirty)) e.preventDefault(); // data is autosaved, but remind about export
});

if (import.meta.env.DEV) {
  (window as any).__S = S;
  (window as any).__utter = (...alts: string[]) => handleUtterance(alts); // simulate speech
  (window as any).__interim = (t: string) => liveHighlight(t); // simulate partial speech
  (window as any).__collisions = () => S.classes.map((c) => [c.parsed.className, warnCommandCollisions(c)]);
}

// ---------- boot ----------
restore().then(() => {
  render();
  if (active()) el.search.focus();
});
