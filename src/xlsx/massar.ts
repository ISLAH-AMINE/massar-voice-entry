/**
 * Read + surgically write Massar "NotesCC" exports.
 *
 * We never rebuild the workbook. Reading is regex-based over the raw XML
 * (works in browser and Node). Writing replaces ONLY the <c> elements of the
 * target score cells inside the sheet XML; every other zip entry is copied
 * byte-for-byte (uncompressed content), and every other byte of the sheet
 * XML is preserved.
 *
 * Handles both variants seen in the wild:
 *  - raw Massar output: `x:` namespace prefix, BOM, inline t="str" strings
 *  - re-saved by Excel: no prefix, shared strings, x14 extLst
 */
import JSZip from 'jszip';

export interface Exam {
  /** Score column letter, e.g. "G" */
  col: string;
  /** Absence column letter (the hidden one next to it), e.g. "H" */
  absCol: string;
  /** Header label, e.g. "الفرض الأول" */
  label: string;
}

export interface Student {
  row: number;
  id: string;
  code: string;
  name: string;
  birth: string;
  /** score per exam column letter; null = empty */
  scores: Record<string, number | null>;
}

export interface MassarFile {
  sheetPath: string;
  className: string;
  subject: string;
  exams: Exam[];
  students: Student[];
}

const dec = new TextDecoder('utf-8', { ignoreBOM: true }); // keep BOM in the string
const enc = new TextEncoder();

export function colToNum(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export function numToCol(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/** Resolve the zip path of the sheet named `name` via workbook.xml + rels. */
async function sheetPathByName(zip: JSZip, name: string): Promise<string> {
  const wb = dec.decode(await zip.file('xl/workbook.xml')!.async('uint8array'));
  const rels = dec.decode(await zip.file('xl/_rels/workbook.xml.rels')!.async('uint8array'));
  const sheetRe = /<(?:\w+:)?sheet\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = sheetRe.exec(wb))) {
    const attrs = m[1];
    const nm = /\bname="([^"]*)"/.exec(attrs)?.[1];
    const rid = /\br:id="([^"]*)"/.exec(attrs)?.[1];
    if (nm && unescapeXml(nm) === name && rid) {
      const relRe = new RegExp(`<(?:\\w+:)?Relationship\\b[^>]*\\bId="${rid}"[^>]*>`);
      const rel = relRe.exec(rels)?.[0];
      const target = rel && /\bTarget="([^"]*)"/.exec(rel)?.[1];
      if (!target) break;
      return target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    }
  }
  throw new Error(`Sheet "${name}" not found`);
}

async function readSharedStrings(zip: JSZip): Promise<string[]> {
  const f = zip.file('xl/sharedStrings.xml');
  if (!f) return [];
  const xml = dec.decode(await f.async('uint8array'));
  const out: string[] = [];
  const siRe = /<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml))) {
    // concatenate all <t> runs, skip phonetic <rPh>
    const body = m[1].replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
    let s = '';
    const tRe = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g;
    let t: RegExpExecArray | null;
    while ((t = tRe.exec(body))) s += unescapeXml(t[1]);
    out.push(s);
  }
  return out;
}

/** Matches one <c> element (self-closing or with content). Group 1 = attrs. */
const CELL_RE = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
const ROW_RE = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g;

interface RawCell {
  ref: string;
  value: string | null; // resolved text value
  numeric: boolean;
}

function parseCells(rowBody: string, sst: string[]): Map<string, RawCell> {
  const cells = new Map<string, RawCell>();
  CELL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CELL_RE.exec(rowBody))) {
    const attrs = m[1];
    const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
    if (!ref) continue;
    const t = /\bt="([^"]*)"/.exec(attrs)?.[1];
    const body = m[2] ?? '';
    let value: string | null = null;
    if (t === 'inlineStr') {
      const tm = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/.exec(body);
      value = tm ? unescapeXml(tm[1]) : null;
    } else {
      const vm = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body);
      if (vm) value = t === 's' ? sst[+vm[1]] ?? null : unescapeXml(vm[1]);
    }
    cells.set(ref, { ref, value, numeric: !t || t === 'n' });
  }
  return cells;
}

export async function loadZip(bytes: Uint8Array | ArrayBuffer): Promise<JSZip> {
  return JSZip.loadAsync(bytes);
}

export async function parseMassar(bytes: Uint8Array | ArrayBuffer): Promise<MassarFile> {
  const zip = await loadZip(bytes);
  const sheetPath = await sheetPathByName(zip, 'NotesCC');
  const xml = dec.decode(await zip.file(sheetPath)!.async('uint8array'));
  const sst = await readSharedStrings(zip);

  const rows: { r: number; cells: Map<string, RawCell> }[] = [];
  ROW_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROW_RE.exec(xml))) {
    const r = +(/\br="(\d+)"/.exec(m[1])?.[1] ?? 0);
    rows.push({ r, cells: parseCells(m[2] ?? '', sst) });
  }

  const txt = (r: { cells: Map<string, RawCell> }, c: string) => (r.cells.get(c)?.value ?? '').trim();

  const headerIdx = rows.findIndex((r) => [...r.cells.values()].some((c) => (c.value ?? '').includes('إسم التلميذ')));
  if (headerIdx < 0) throw new Error('Header row "إسم التلميذ" not found — is this a Massar NotesCC export?');
  const header = rows[headerIdx];
  const sub = rows[headerIdx + 1]; // "النقطة" / "التغيب"

  // Score columns = sub-header cells reading "النقطة"; absence column = next one.
  const exams: Exam[] = [];
  for (const c of sub?.cells.values() ?? []) {
    if ((c.value ?? '').trim() === 'النقطة') {
      const n = colToNum(c.ref);
      const absCol = numToCol(n + 1);
      exams.push({ col: c.ref, absCol, label: txt(header, c.ref) || c.ref });
    }
  }
  exams.sort((a, b) => colToNum(a.col) - colToNum(b.col));
  if (exams.length === 0) throw new Error('No score columns ("النقطة") found under the header row');

  const students: Student[] = [];
  for (const row of rows.slice(headerIdx + 2)) {
    const name = txt(row, 'D');
    if (!name) continue;
    const scores: Record<string, number | null> = {};
    for (const e of exams) {
      const v = row.cells.get(e.col)?.value;
      scores[e.col] = v == null || v.trim() === '' || isNaN(+v) ? null : +v;
    }
    students.push({ row: row.r, id: txt(row, 'B'), code: txt(row, 'C'), name, birth: txt(row, 'F'), scores });
  }

  // Header info: class (label "القسم") and subject ("المادة"); value is the next non-empty cell.
  const labelValue = (label: string): string => {
    for (const r of rows.slice(0, headerIdx)) {
      const cells = [...r.cells.values()].sort((a, b) => colToNum(a.ref) - colToNum(b.ref));
      const i = cells.findIndex((c) => (c.value ?? '').includes(label));
      if (i >= 0) {
        const v = cells.slice(i + 1).find((c) => (c.value ?? '').trim());
        if (v) return v.value!.trim();
      }
    }
    return '';
  };

  return { sheetPath, className: labelValue('القسم'), subject: labelValue('المادة'), exams, students };
}

/** cell ref ("G18") → new numeric value, or null to clear */
export type CellEdits = Map<string, number | null>;

export function formatNumber(v: number): string {
  // Excel-style shortest representation: 15.5, 9.75, 12
  return String(+v.toFixed(2));
}

/**
 * Return a new sheet XML where only the given cells' <c> nodes are replaced.
 * Exported for tests.
 */
export function patchSheetXml(xml: string, edits: CellEdits): string {
  if (edits.size === 0) return xml;
  const prefix = /<(\w+:)?worksheet\b/.exec(xml)?.[1] ?? '';
  const pending = new Map(edits);

  // 1) Replace existing cells in place.
  let out = xml.replace(CELL_RE, (whole, attrs: string) => {
    const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref || !pending.has(ref)) return whole;
    const v = pending.get(ref)!;
    pending.delete(ref);
    return buildCell(prefix, attrs, v);
  });

  // 2) Cells that don't exist yet: insert into their row at the right column position.
  if (pending.size) {
    const byRow = new Map<number, [string, number | null][]>();
    for (const [ref, v] of pending) {
      const r = +/\d+$/.exec(ref)![0];
      if (!byRow.has(r)) byRow.set(r, []);
      byRow.get(r)!.push([ref, v]);
    }
    out = out.replace(ROW_RE, (whole, attrs: string, body: string | undefined) => {
      const r = +(/\br="(\d+)"/.exec(attrs)?.[1] ?? 0);
      const list = byRow.get(r);
      if (!list) return whole;
      byRow.delete(r);
      if (body === undefined) throw new Error(`Row ${r} is empty (self-closing); refusing to restructure it`);
      let newBody = body;
      for (const [ref, v] of list) {
        if (v === null) continue; // clearing a non-existent cell = no-op
        const col = colToNum(/^[A-Z]+/.exec(ref)![0]);
        const node = buildCell(prefix, ` r="${ref}"`, v);
        // find first cell with a larger column and insert before it
        let insertAt = newBody.length;
        CELL_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = CELL_RE.exec(newBody))) {
          const c = /\br="([A-Z]+)\d+"/.exec(m[1])?.[1];
          if (c && colToNum(c) > col) {
            insertAt = m.index;
            break;
          }
        }
        newBody = newBody.slice(0, insertAt) + node + newBody.slice(insertAt);
      }
      const open = whole.slice(0, whole.indexOf('>') + 1);
      const close = whole.slice(whole.lastIndexOf('</'));
      return open + newBody + close;
    });
    for (const [r, list] of byRow) {
      if (list.some(([, v]) => v !== null)) throw new Error(`Row ${r} not found in sheet`);
    }
  }
  return out;
}

function buildCell(prefix: string, attrs: string, v: number | null): string {
  // keep r, s and any other attribute; drop the type (numbers are the default)
  const a = attrs.replace(/\s+t="[^"]*"/, '').replace(/\s+$/, '');
  if (v === null) return `<${prefix}c${a}/>`;
  return `<${prefix}c${a}><${prefix}v>${formatNumber(v)}</${prefix}v></${prefix}c>`;
}

/**
 * Produce a new .xlsx: identical to the original except the edited cells.
 * Edits whose value equals the original value are dropped, so the original
 * node is kept untouched.
 */
export async function exportMassar(original: Uint8Array | ArrayBuffer, edits: CellEdits): Promise<Uint8Array> {
  const zip = await loadZip(original);
  const sheetPath = await sheetPathByName(zip, 'NotesCC');
  const parsed = await parseMassar(original);

  // drop no-op edits
  const effective: CellEdits = new Map();
  for (const [ref, v] of edits) {
    const col = /^[A-Z]+/.exec(ref)![0];
    const row = +/\d+$/.exec(ref)![0];
    const st = parsed.students.find((s) => s.row === row);
    if (!st || !(col in st.scores)) throw new Error(`Refusing to write ${ref}: not a student score cell`);
    if (v !== null && !(v >= 0 && v <= 20)) throw new Error(`Refusing to write ${ref}=${v}: out of range`);
    if ((st.scores[col] ?? null) !== v) effective.set(ref, v);
  }

  if (effective.size) {
    const xml = dec.decode(await zip.file(sheetPath)!.async('uint8array'));
    // createFolders:false — otherwise JSZip adds "xl/" + "xl/worksheets/" entries
    const date = zip.file(sheetPath)!.date;
    zip.file(sheetPath, enc.encode(patchSheetXml(xml, effective)), { createFolders: false, date });
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
