const XLSX = require("xlsx");
const supabase = require("../config/supabase");
const { findHeaderRowIndex, rowToObject } = require("../utils/excelParse");

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

      const dataRows = rows.slice(headerRowIndex + 1);

      summary.sheetsProcessed++;

      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        const rowNumber = headerRowIndex + 2 + i;
        const parsed = rowToObject(rows[headerRowIndex], row, sheetName);

        summary.rowsTotal++;

        if (!parsed.accountNumber || !parsed.studentName) {
          summary.rowsSkipped++;
          summary.skippedRows.push({
            sheet: sheetName,
            rowNumber,
            reason: "missing admission number or name",
          });
          continue;
        }

        const record = {
          admission_number: parsed.accountNumber,
          full_name: parsed.studentName,
          contact: parsed.contact,
          class_stream: sheetName,
          opening_balance: parsed.openingBalance,
          previous_balance: parsed.previousBalance,
          current_balance: parsed.currentBalance,
          term_amount: parsed.termAmount,
          raw_row: parsed.rawRow,
        };

        const { error: upsertError } = await supabase
          .from("students")
          .upsert(record, { onConflict: "admission_number" });

        if (upsertError) {
          summary.rowsSkipped++;
          summary.rowsTotal--;
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

/**
 * GET /api/students/sheets
 * Distinct class_stream values (Excel sheet names) with row counts.
 */
async function listStudentSheets(req, res, next) {
  try {
    const { data, error } = await supabase
      .from("students")
      .select("class_stream")
      .not("class_stream", "is", null);

    if (error) throw error;

    const counts = {};
    for (const row of data || []) {
      const name = row.class_stream;
      if (!name) continue;
      counts[name] = (counts[name] || 0) + 1;
    }

    const sheets = Object.entries(counts)
      .map(([sheetName, studentCount]) => ({ sheetName, studentCount }))
      .sort((a, b) => a.sheetName.localeCompare(b.sheetName));

    res.json({ success: true, sheets });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/students/sheets/:sheetName
 * Deletes all students whose class_stream matches the Excel sheet name.
 */
async function deleteStudentSheet(req, res, next) {
  try {
    const sheetName = decodeURIComponent(req.params.sheetName || "").trim();
    if (!sheetName) {
      return res.status(400).json({ success: false, message: "sheetName is required" });
    }

    const { data, error } = await supabase
      .from("students")
      .delete()
      .eq("class_stream", sheetName)
      .select("id");

    if (error) throw error;

    res.json({
      success: true,
      message: `Deleted sheet "${sheetName}"`,
      deletedStudents: (data || []).length,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  importStudents,
  listStudents,
  listStudentSheets,
  deleteStudentSheet,
};
