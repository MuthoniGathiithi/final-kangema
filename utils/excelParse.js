/**
 * Shared Excel fee-register parsing helpers.
 * Real headers are often a few rows down after a title/date section — never assume row 1.
 */

const HEADER_MAP = {
  admission_number: ["adm", "adm no", "adm number", "admission no", "admission number", "account number", "account no", "acc no", "account"],
  full_name: ["name", "student name", "full name", "names", "fullname"],
  contact: ["contact", "phone", "mobile", "phone number", "contact number", "guardian contact"],
  opening_balance: ["o.p.bal", "op bal", "opening balance", "opbal", "o p bal"],
  previous_balance: ["p.p.bal", "pp bal", "previous balance", "ppbal", "p p bal"],
  current_balance: ["c.p.bal", "cp bal", "current balance", "cpbal", "c p bal"],
  term_amount: ["term 3", "term3", "term amount", "term 3 amount", "term3 amount", "term 1", "term 2", "term", "amount", "fee", "balance"],
  track: ["track", "track name", "track_name", "trackname"],
};

function normalizeHeaderCell(cell) {
  if (cell === null || cell === undefined) return "";
  return String(cell).trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Scans the first N rows for a header that has both admission-number and name columns.
 */
function findHeaderRowIndex(rows, maxRowsToScan = 15) {
  const limit = Math.min(rows.length, maxRowsToScan);
  for (let i = 0; i < limit; i++) {
    const row = rows[i] || [];
    const normalizedCells = row.map(normalizeHeaderCell);

    const hasAdm = normalizedCells.some((cell) => HEADER_MAP.admission_number.includes(cell));
    const hasName = normalizedCells.some((cell) => HEADER_MAP.full_name.includes(cell));

    if (hasAdm && hasName) return i;
  }
  return -1;
}

/**
 * Builds { ourColumnName: cellIndex } from a header row.
 */
function buildColumnIndex(headerRow) {
  const index = {};
  const normalizedCells = headerRow.map(normalizeHeaderCell);

  for (const [ourColumn, spellings] of Object.entries(HEADER_MAP)) {
    const cellIndex = normalizedCells.findIndex((cell) => spellings.includes(cell));
    if (cellIndex !== -1) index[ourColumn] = cellIndex;
  }
  return index;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  let cleaned = String(value).trim();
  cleaned = cleaned.replace(/[Kk][Ss][Hh]/g, "");
  cleaned = cleaned.replace(/[Kk][Ee][Ss]/g, "");
  cleaned = cleaned.replace(/[Kk][Ss]/g, "");
  cleaned = cleaned.replace(/[$£€]/g, "");
  cleaned = cleaned.replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Converts a raw data row + header into an object keyed by header text,
 * plus normalized fields used by Excel matching / students upsert.
 */
function rowToObject(headerRow, dataRow, sheetName) {
  const columnIndex = buildColumnIndex(headerRow);
  const rawRow = {};
  headerRow.forEach((headerCell, idx) => {
    const key =
      headerCell !== null && headerCell !== undefined
        ? String(headerCell).trim()
        : `col_${idx}`;
    rawRow[key || `col_${idx}`] = dataRow[idx] ?? null;
  });

  const admissionRaw =
    columnIndex.admission_number !== undefined ? dataRow[columnIndex.admission_number] : null;
  const nameRaw = columnIndex.full_name !== undefined ? dataRow[columnIndex.full_name] : null;
  const trackRaw = columnIndex.track !== undefined ? dataRow[columnIndex.track] : null;

  const accountNumber =
    admissionRaw !== null && admissionRaw !== undefined && String(admissionRaw).trim() !== ""
      ? String(admissionRaw).trim()
      : null;
  const studentName =
    nameRaw !== null && nameRaw !== undefined && String(nameRaw).trim() !== ""
      ? String(nameRaw).trim()
      : null;
  const trackName =
    trackRaw !== null && trackRaw !== undefined && String(trackRaw).trim() !== ""
      ? String(trackRaw).trim()
      : sheetName || null;

  let amount = 0;
  if (columnIndex.term_amount !== undefined) {
    amount = toNumber(dataRow[columnIndex.term_amount]);
  } else if (columnIndex.current_balance !== undefined) {
    amount = toNumber(dataRow[columnIndex.current_balance]);
  } else if (columnIndex.opening_balance !== undefined) {
    amount = toNumber(dataRow[columnIndex.opening_balance]);
  }

  return {
    rawRow,
    accountNumber,
    studentName,
    trackName,
    amount,
    openingBalance: toNumber(
      columnIndex.opening_balance !== undefined ? dataRow[columnIndex.opening_balance] : 0
    ),
    previousBalance: toNumber(
      columnIndex.previous_balance !== undefined ? dataRow[columnIndex.previous_balance] : 0
    ),
    currentBalance: toNumber(
      columnIndex.current_balance !== undefined ? dataRow[columnIndex.current_balance] : 0
    ),
    termAmount: toNumber(
      columnIndex.term_amount !== undefined ? dataRow[columnIndex.term_amount] : 0
    ),
    contact:
      columnIndex.contact !== undefined
        ? String(dataRow[columnIndex.contact] ?? "").trim() || null
        : null,
    columnIndex,
  };
}

module.exports = {
  HEADER_MAP,
  normalizeHeaderCell,
  findHeaderRowIndex,
  buildColumnIndex,
  toNumber,
  rowToObject,
};
