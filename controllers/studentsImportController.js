const XLSX = require("xlsx");
const supabase = require("../config/supabase");

// Header cell spellings we'll recognize, mapped to our column names.
// Matching is case-insensitive and ignores punctuation/extra spaces.
const HEADER_MAP = {
  admission_number: ["adm", "adm no", "adm number", "admission no", "admission number"],
  full_name: ["name", "student name", "full name", "names"],
  contact: ["contact", "phone", "mobile", "phone number", "contact number", "guardian contact"],
  opening_balance: ["o.p.bal", "op bal", "opening balance", "opbal", "o p bal"],
  previous_balance: ["p.p.bal", "pp bal", "previous balance", "ppbal", "p p bal"],
  current_balance: ["c.p.bal", "cp bal", "current balance", "cpbal", "c p bal"],
  term_amount: ["term 3", "term3", "term amount", "term 3 amount", "term3 amount"],
};

function normalizeHeaderCell(cell) {
  if (cell === null || cell === undefined) return "";
  return String(cell).trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Scans the first N rows of a sheet (as arrays) looking for the row that looks
 * like a header - the fee register's real header isn't row 1, it's a few rows
 * down after a title/date section. We consider a row "the header" once it
 * contains both something that looks like an admission-number column AND a
 * name column.
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
 * Builds a map of { ourColumnName: cellIndex } by matching each header cell
 * against HEADER_MAP. Unrecognized columns are simply ignored (not an error) -
 * they just won't be pulled into named fields, though the full row is still
 * kept in raw_row for reference.
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
  const cleaned = String(value).replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/**
 * POST /api/students/import
 * multipart/form-data, field "file" - a workbook with one sheet per class/stream.
 * Each sheet's real header row is auto-detected (not assumed to be row 1).
 * Rows are upserted into the `students` table, keyed by admission_number.
 * The sheet name is stored as class_stream.
 */
async function importStudents(req, res, next) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "No file uploaded (field name must be 'file')" });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });

    const summary = {
      sheetsProcessed: 0,
      sheetsSkipped: [],
      rowsTotal: 0,
      rowsImported: 0,
      rowsSkipped: 0,
      skippedRows: [], // { sheet, rowNumber, reason }
    };

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      // header: 1 -> array-of-arrays, so we can scan for the header row ourselves
      // rather than assuming row 1 is it.
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, blankrows: false });

      if (rows.length === 0) {
        summary.sheetsSkipped.push({ sheet: sheetName, reason: "empty sheet" });
        continue;
      }

      const headerRowIndex = findHeaderRowIndex(rows);
      if (headerRowIndex === -1) {
        summary.sheetsSkipped.push({
          sheet: sheetName,
          reason: "could not find a header row with both an admission-number and a name column",
        });
        continue;
      }

      const columnIndex = buildColumnIndex(rows[headerRowIndex]);
      const dataRows = rows.slice(headerRowIndex + 1);

      summary.sheetsProcessed++;

      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        const rowNumber = headerRowIndex + 2 + i; // +2: 1-indexed, plus the header row itself

        const admissionNumber =
          columnIndex.admission_number !== undefined
            ? row[columnIndex.admission_number]
            : null;
        const fullName =
          columnIndex.full_name !== undefined ? row[columnIndex.full_name] : null;

        summary.rowsTotal++;

        if (!admissionNumber || !fullName) {
          summary.rowsSkipped++;
          summary.skippedRows.push({
            sheet: sheetName,
            rowNumber,
            reason: "missing admission number or name",
          });
          continue;
        }

        // Keep the full raw row (as an object keyed by whatever header text was found,
        // falling back to a column index) for reference/debugging, regardless of
        // which columns we recognized.
        const headerRow = rows[headerRowIndex];
        const rawRow = {};
        headerRow.forEach((headerCell, idx) => {
          const key = headerCell !== null && headerCell !== undefined ? String(headerCell).trim() : `col_${idx}`;
          rawRow[key || `col_${idx}`] = row[idx] ?? null;
        });

        const record = {
          admission_number: String(admissionNumber).trim(),
          full_name: String(fullName).trim(),
          contact: columnIndex.contact !== undefined ? String(row[columnIndex.contact] ?? "").trim() || null : null,
          class_stream: sheetName,
          opening_balance: toNumber(columnIndex.opening_balance !== undefined ? row[columnIndex.opening_balance] : 0),
          previous_balance: toNumber(columnIndex.previous_balance !== undefined ? row[columnIndex.previous_balance] : 0),
          current_balance: toNumber(columnIndex.current_balance !== undefined ? row[columnIndex.current_balance] : 0),
          term_amount: toNumber(columnIndex.term_amount !== undefined ? row[columnIndex.term_amount] : 0),
          raw_row: rawRow,
        };

        const { error: upsertError } = await supabase
          .from("students")
          .upsert(record, { onConflict: "admission_number" });

        if (upsertError) {
          summary.rowsSkipped++;
          summary.rowsTotal--; // don't double count - this row didn't actually make it in
          summary.skippedRows.push({
            sheet: sheetName,
            rowNumber,
            reason: `database error: ${upsertError.message}`,
          });
          continue;
        }

        summary.rowsImported++;
      }
    }

    res.json({ success: true, ...summary });
  } catch (err) {
    next(err);
  }
}

function formatStudent(row) {
  return {
    id: row.id,
    admissionNumber: row.admission_number,
    fullName: row.full_name,
    contact: row.contact,
    classStream: row.class_stream,
    openingBalance: Number(row.opening_balance),
    previousBalance: Number(row.previous_balance),
    currentBalance: Number(row.current_balance),
    termAmount: Number(row.term_amount),
    importedAt: row.imported_at,
    updatedAt: row.updated_at,
  };
}

/**
 * GET /api/students?page=1&pageSize=25&search=&classStream=
 */
async function listStudents(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const pageSize = Math.min(parseInt(req.query.pageSize) || 25, 500);
    const { search, classStream } = req.query;

    let query = supabase
      .from("students")
      .select("*", { count: "exact" })
      .order("class_stream", { ascending: true })
      .order("full_name", { ascending: true });

    if (search) {
      query = query.or(`full_name.ilike.%${search}%,admission_number.ilike.%${search}%`);
    }
    if (classStream) {
      query = query.eq("class_stream", classStream);
    }

    const start = (page - 1) * pageSize;
    const end = start + pageSize - 1;
    query = query.range(start, end);

    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      success: true,
      page,
      pageSize,
      total: count,
      students: data.map(formatStudent),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { importStudents, listStudents };