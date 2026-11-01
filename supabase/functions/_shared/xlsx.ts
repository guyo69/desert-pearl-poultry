// A small .xlsx writer: one worksheet per sheet, a bold frozen header row,
// real numbers, and ISO dates (YYYY-MM-DD) as Excel dates. Built on fflate's
// zip so it stays well inside the edge function CPU budget (exceljs works in
// Deno too, but pulls in deprecated dependencies and a much larger bundle).
import { strToU8, zipSync } from 'npm:fflate@0.8.2';

export type Cell = string | number | boolean | null | undefined;
export interface Sheet { name: string; columns: string[]; rows: Cell[][] }

// characters XML 1.0 cannot carry are dropped, the rest escaped
const esc = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Excel serial day number (1900 date system) of an ISO date. */
export const serial = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5 + 25569;
const colName = (i: number) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
/** Sheet names: at most 31 characters, none of []:*?/\ , unique. */
export function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((n) => {
    const base = (n.replace(/[\[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim() || 'Sheet').slice(0, 31);
    let name = base;
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base.slice(0, 31 - String(k).length - 1)} ${k}`;
    used.add(name.toLowerCase());
    return name;
  });
}

function cellXml(ref: string, v: Cell, header: boolean): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${header ? ' s="1"' : ''}><v>${v}</v></c>`;
  if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
  const s = String(v);
  if (!header && ISO_DATE.test(s)) return `<c r="${ref}" s="2"><v>${serial(s)}</v></c>`;
  return `<c r="${ref}" t="inlineStr"${header ? ' s="1"' : ''}><is><t xml:space="preserve">${esc(s)}</t></is></c>`;
}

function sheetXml(sh: Sheet): string {
  const all = [sh.columns as Cell[], ...sh.rows];
  const widths = sh.columns.map((_, c) => Math.min(48, Math.max(8, ...all.map((r) => {
    const v = r[c]; return v === null || v === undefined ? 0 : ISO_DATE.test(String(v)) ? 11 : String(v).length + 2;
  }))));
  const rows = all.map((r, i) => `<row r="${i + 1}">${sh.columns.map((_, c) => cellXml(`${colName(c)}${i + 1}`, r[c], i === 0)).join('')}</row>`).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${rows}</sheetData></worksheet>`;
}

export function xlsx(sheets: Sheet[]): Uint8Array {
  const list = sheets.length ? sheets : [{ name: 'No entries', columns: ['Nothing was entered in this period'], rows: [] }];
  const names = sheetNames(list.map((s) => s.name));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '</Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="1"><numFmt numFmtId="164" formatCode="ddd d mmm yyyy"/></numFmts>' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
      '</styleSheet>'),
  };
  list.forEach((sh, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sh)); });
  return zipSync(files, { level: 6 });
}

/** Fallback when a workbook cannot be built: one CSV per sheet, joined with a blank line. */
export function csv(sheets: Sheet[]): string {
  const q = (v: Cell) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return sheets.map((s) => [s.name, s.columns.map(q).join(','), ...s.rows.map((r) => r.map(q).join(','))].join('\n')).join('\n\n');
}
