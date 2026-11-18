/**
 * Integrity test: export must change ONLY the target score cells.
 *
 * For every fixture:
 *  1. Same zip entries, same order.
 *  2. Every entry except the NotesCC sheet is byte-identical (uncompressed).
 *  3. In the sheet XML, if we cut out the target <c> nodes from both the
 *     original and the exported XML, the remaining bytes are identical.
 *  4. Re-parsing the export yields exactly the new scores; all other
 *     scores are unchanged.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { parseMassar, exportMassar, type CellEdits } from '../src/xlsx/massar';

const FIX = join(__dirname, 'fixtures');
// Real Massar exports are kept local only (student data, git-ignored): skip when absent.
const files = existsSync(FIX) ? readdirSync(FIX).filter((f) => f.endsWith('.xlsx')) : [];
if (!files.length) it.skip('real Massar exports not present in test/fixtures/', () => {});
const dec = new TextDecoder('utf-8', { ignoreBOM: true });

function cutCells(xml: string, refs: string[]): string {
  let out = xml;
  for (const ref of refs) {
    const re = new RegExp(`<(?:\\w+:)?c\\b[^>]*\\br="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</(?:\\w+:)?c>)`);
    const before = out;
    out = out.replace(re, `@@${ref}@@`);
    expect(out, `cell ${ref} must exist exactly where expected`).not.toBe(before);
  }
  return out;
}

async function entries(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files);
  const data = new Map<string, Uint8Array>();
  for (const n of names) data.set(n, await zip.files[n].async('uint8array'));
  return { names, data };
}

describe.each(files)('%s', (file) => {
  const original = new Uint8Array(readFileSync(join(FIX, file)));

  it('parses students and the 4 exam columns', async () => {
    const p = await parseMassar(original);
    expect(p.exams.map((e) => e.col)).toEqual(['G', 'I', 'K', 'M']);
    expect(p.exams.map((e) => e.absCol)).toEqual(['H', 'J', 'L', 'N']);
    expect(p.exams[0].label).toBe('الفرض الأول');
    expect(p.exams[3].label).toBe('الأنشطة المندمجة');
    expect(p.students.length).toBeGreaterThan(20);
    expect(p.students[0].row).toBe(18);
    for (const s of p.students) expect(s.name.length).toBeGreaterThan(2);
    expect(p.className).toMatch(/APIC-\d/);
  });

  it('export with no edits keeps every entry byte-identical', async () => {
    const out = await exportMassar(original, new Map());
    const a = await entries(original);
    const b = await entries(out);
    expect(b.names).toEqual(a.names);
    for (const n of a.names) expect(Buffer.from(b.data.get(n)!).equals(Buffer.from(a.data.get(n)!)), n).toBe(true);
  });

  it('export changes only the target cells', async () => {
    const p = await parseMassar(original);
    const s = p.students;
    const edits: CellEdits = new Map<string, number | null>([
      [`G${s[0].row}`, 15.5],
      [`I${s[1].row}`, 12.75],
      [`K${s[2].row}`, 0],
      [`M${s[s.length - 1].row}`, 20],
    ]);
    // if a fixture already has a G score somewhere, also test clearing it
    const filled = s.find((x, i) => i > 3 && x.scores.G !== null);
    if (filled) edits.set(`G${filled.row}`, null);

    const out = await exportMassar(original, edits);
    const a = await entries(original);
    const b = await entries(out);
    expect(b.names).toEqual(a.names);

    const sheet = p.sheetPath;
    for (const n of a.names) {
      if (n === sheet) continue;
      expect(Buffer.from(b.data.get(n)!).equals(Buffer.from(a.data.get(n)!)), `${n} must be byte-identical`).toBe(true);
    }

    const refs = [...edits.keys()];
    const xa = dec.decode(a.data.get(sheet)!);
    const xb = dec.decode(b.data.get(sheet)!);
    expect(xb).not.toBe(xa);
    expect(cutCells(xb, refs)).toBe(cutCells(xa, refs)); // everything else identical, incl. BOM

    // protection, extensions, markers still present
    for (const needle of ['sheetProtection', '#1#', '#4#'].filter((x) => xa.includes(x))) expect(xb).toContain(needle);
    if (xa.includes('x14:dataValidation')) expect(xb).toContain('x14:dataValidation');

    const q = await parseMassar(out);
    q.students.forEach((st, i) => {
      for (const col of ['G', 'I', 'K', 'M']) {
        const ref = `${col}${st.row}`;
        const expected = edits.has(ref) ? edits.get(ref) : p.students[i].scores[col];
        expect(st.scores[col], ref).toBe(expected);
      }
    });

    // independent check: the system unzip can read the result
    const dir = mkdtempSync(join(tmpdir(), 'massar-'));
    const fp = join(dir, file);
    writeFileSync(fp, out);
    try {
      const res = execFileSync('unzip', ['-tq', fp]).toString();
      expect(res).toMatch(/No errors/);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e; // unzip not installed → skip this extra check
    }
  });

  it('refuses to write outside student score cells', async () => {
    await expect(exportMassar(original, new Map([['G5', 3]]))).rejects.toThrow();
    await expect(exportMassar(original, new Map([['O18', 3]]))).rejects.toThrow();
    await expect(exportMassar(original, new Map([['G18', 21]]))).rejects.toThrow();
  });
});
