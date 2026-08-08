// Minimal RFC-4180 CSV parser for the Setmore export. No dependency —
// the migration scripts must run from a bare `npm install` on cutover
// morning.
//
// Handles quoted fields, escaped quotes (""), embedded commas and
// newlines, and CRLF/LF endings. FAILS on ragged rows (a row whose
// field count differs from the header) instead of padding — a
// truncated export must not silently become a shorter import.

export function parseCsv(text) {
  // Excel-flavored exports often open with a UTF-8 BOM; strip it so
  // the first header name doesn't silently become U+FEFF +
  // 'Appointment ID' and break every column lookup.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    // Skip completely empty trailing lines (a final "\n" is common).
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (c === '\r' && text[i + 1] === '\n') {
      pushRow();
      i += 2;
      continue;
    }
    if (c === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (inQuotes) {
    throw new Error('CSV parse error: unterminated quoted field at end of input');
  }
  if (field !== '' || row.length > 0) pushRow();

  if (rows.length === 0) {
    throw new Error('CSV parse error: no rows (empty file?)');
  }

  const header = rows[0];
  const records = [];
  for (let r = 1; r < rows.length; r += 1) {
    if (rows[r].length !== header.length) {
      throw new Error(
        `CSV parse error: row ${r + 1} has ${rows[r].length} fields, ` +
          `header has ${header.length} — export is corrupt or truncated`,
      );
    }
    const rec = {};
    for (let c = 0; c < header.length; c += 1) {
      rec[header[c]] = rows[r][c];
    }
    records.push(rec);
  }
  return { header, records };
}
