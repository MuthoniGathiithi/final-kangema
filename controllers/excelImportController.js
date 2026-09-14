const XLSX = require("xlsx");
const supabase = require("../config/supabase");

/**
 * Finds the account-number-like column in a row, trying a few common header spellings.
 */
function extractAccountNumber(row) {
  const candidates = [
    "account number",
    "account_number",
    "accountnumber",
    "account no",
    "acc no",
    "account",
    "reference",
  ];
  const keys = Object.keys(row);
  for (const key of keys) {
    if (candidates.includes(key.trim().toLowerCase())) {
      return String(row[key]).trim();
    }
  }
  return null;
}

/**
 * POST /api/excel/import
 * multipart/form-data with a single field "file" (.xlsx or .xls)
 *
 * Every row must contain an account-number column (see extractAccountNumber above).
 * All other columns in the row are stored as-is in supplementary_data, and merged
 * into the matching transaction (matched by account_number).
 */
async function importExcel(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded (field name must be 'file')" });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });

    let matched = 0;
    let unmatched = 0;
    const unmatchedRows = [];

    // Log the import batch first
    const { data: importRow, error: importError } = await supabase
      .from("excel_imports")
      .insert({ file_name: req.file.originalname, rows_total: rows.length })
      .select()
      .single();

    if (importError) throw importError;

    for (const row of rows) {
      const accountNumber = extractAccountNumber(row);

      if (!accountNumber) {
        unmatched++;
        unmatchedRows.push({ import_id: importRow.id, account_number: null, row_data: row });
        continue;
      }

      // Find transaction(s) with this account number
      const { data: existing, error: findError } = await supabase
        .from("transactions")
        .select("id")
        .eq("account_number", accountNumber);

      if (findError) throw findError;

      if (!existing || existing.length === 0) {
        unmatched++;
        unmatchedRows.push({ import_id: importRow.id, account_number: accountNumber, row_data: row });
        continue;
      }

      // Merge supplementary data into every matching transaction
      for (const tx of existing) {
        const { error: updateError } = await supabase
          .from("transactions")
          .update({ supplementary_data: row, linked_at: new Date().toISOString() })
          .eq("id", tx.id);

        if (updateError) throw updateError;
      }
      matched++;
    }

    if (unmatchedRows.length > 0) {
      const { error: unmatchedInsertError } = await supabase
        .from("excel_unmatched_rows")
        .insert(unmatchedRows);
      if (unmatchedInsertError) console.error("[excel import] failed to log unmatched rows:", unmatchedInsertError);
    }

    await supabase
      .from("excel_imports")
      .update({ rows_matched: matched, rows_unmatched: unmatched })
      .eq("id", importRow.id);

    res.json({
      success: true,
      importId: importRow.id,
      rowsTotal: rows.length,
      rowsMatched: matched,
      rowsUnmatched: unmatched,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/excel/data
 * Returns all imported Excel records
 */
async function getExcelData(req, res, next) {
  try {
    const { data: rows, error } = await supabase
      .from("excel_unmatched_rows")
      .select("id, account_number, row_data, import_id, created_at")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const formattedData = rows.map((row) => {
      const rowData = row.row_data || {};
      return {
        id: row.id,
        accountNumber: row.account_number || "",
        name: rowData.name || rowData.Name || "",
        amount: rowData.amount || rowData.Amount || 0,
        notes: rowData.notes || rowData.Notes || null,
        category: rowData.category || rowData.Category || null,
        importId: row.import_id,
        importedAt: row.created_at,
      };
    });

    res.json({
      success: true,
      data: formattedData,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { importExcel, getExcelData };
