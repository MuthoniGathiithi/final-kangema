const XLSX = require("xlsx");
const supabase = require("../config/supabase");
const { findHeaderRowIndex, rowToObject } = require("../utils/excelParse");

/**
 * Parse every sheet in a workbook into normalized row objects.
 * Auto-detects the real header row (fee registers put titles/dates above the header).
 */
function parseWorkbookSheets(workbook) {
  const sheets = [];
  const skipped = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: null,
      blankrows: false,
    });

    if (rows.length === 0) {
      skipped.push({ sheet: sheetName, reason: "empty sheet" });
      continue;
    }

    const headerRowIndex = findHeaderRowIndex(rows);
    if (headerRowIndex === -1) {
      skipped.push({
        sheet: sheetName,
        reason: "could not find a header row with both an admission-number and a name column",
      });
      continue;
    }

    const headerRow = rows[headerRowIndex];
    const dataRows = rows.slice(headerRowIndex + 1);
    const parsedRows = [];

    for (let i = 0; i < dataRows.length; i++) {
      const parsed = rowToObject(headerRow, dataRows[i], sheetName);
      // Skip completely empty data rows
      if (!parsed.accountNumber && !parsed.studentName) continue;
      parsedRows.push({
        ...parsed,
        sheetName,
        rowNumber: headerRowIndex + 2 + i,
      });
    }

    sheets.push({
      sheetName,
      headerRowIndex,
      columns: headerRow.map((c) => (c == null ? "" : String(c).trim())),
      rows: parsedRows,
    });
  }

  return { sheets, skipped };
}

/**
 * POST /api/excel/import
 * multipart/form-data with a single field "file" (.xlsx or .xls)
 * Processes ALL sheets; detects the real header row on each sheet.
 */
async function importExcel(req, res, next) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, message: "No file uploaded (field name must be 'file')" });
    }

    console.log("========== EXCEL IMPORT START ==========");
    console.log("[excel import] File:", req.file.originalname, "size:", req.file.size);

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const { sheets, skipped } = parseWorkbookSheets(workbook);

    const allRows = sheets.flatMap((s) => s.rows);
    console.log(
      "[excel import] Sheets processed:",
      sheets.length,
      "skipped:",
      skipped.length,
      "data rows:",
      allRows.length
    );

    if (sheets.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          "No usable sheets found. Each sheet needs a header row with both an admission/account column and a name column.",
        sheetsSkipped: skipped,
      });
    }

    let matched = 0;
    let unmatched = 0;
    const unmatchedRows = [];
    const sheetSummary = [];

    const { data: importRow, error: importError } = await supabase
      .from("excel_imports")
      .insert({
        file_name: req.file.originalname,
        rows_total: allRows.length,
        details: {
          sheetsProcessed: sheets.map((s) => s.sheetName),
          sheetsSkipped: skipped,
        },
      })
      .select()
      .single();

    if (importError) {
      console.error("[excel import] Failed to create import record:", importError);
      throw importError;
    }

    for (const sheet of sheets) {
      let sheetMatched = 0;
      let sheetUnmatched = 0;

      for (const parsed of sheet.rows) {
        const enrichedRow = {
          ...parsed.rawRow,
          studentName: parsed.studentName,
          name: parsed.studentName,
          amount: parsed.amount,
          sheetName: parsed.sheetName,
          trackName: parsed.trackName,
        };

        if (!parsed.accountNumber) {
          unmatched++;
          sheetUnmatched++;
          unmatchedRows.push({
            import_id: importRow.id,
            account_number: null,
            row_data: enrichedRow,
            sheet_name: parsed.sheetName,
            track_name: parsed.trackName,
          });
          continue;
        }

        const { data: existing, error: findError } = await supabase
          .from("transactions")
          .select("id")
          .eq("account_number", parsed.accountNumber);

        if (findError) throw findError;

        if (!existing || existing.length === 0) {
          unmatched++;
          sheetUnmatched++;
          unmatchedRows.push({
            import_id: importRow.id,
            account_number: parsed.accountNumber,
            row_data: enrichedRow,
            sheet_name: parsed.sheetName,
            track_name: parsed.trackName,
          });
          continue;
        }

        for (const tx of existing) {
          const { error: updateError } = await supabase
            .from("transactions")
            .update({
              supplementary_data: enrichedRow,
              linked_at: new Date().toISOString(),
            })
            .eq("id", tx.id);

          if (updateError) throw updateError;
        }

        matched++;
        sheetMatched++;
      }

      sheetSummary.push({
        sheet: sheet.sheetName,
        rows: sheet.rows.length,
        matched: sheetMatched,
        unmatched: sheetUnmatched,
      });
    }

    if (unmatchedRows.length > 0) {
      const { error: unmatchedInsertError } = await supabase
        .from("excel_unmatched_rows")
        .insert(unmatchedRows);
      if (unmatchedInsertError) {
        console.error("[excel import] failed to log unmatched rows:", unmatchedInsertError);
      }
    }

    await supabase
      .from("excel_imports")
      .update({ rows_matched: matched, rows_unmatched: unmatched })
      .eq("id", importRow.id);

    console.log("[excel import] Done. matched:", matched, "unmatched:", unmatched);
    console.log("========== EXCEL IMPORT END ==========");

    res.json({
      success: true,
      importId: importRow.id,
      rowsTotal: allRows.length,
      rowsMatched: matched,
      rowsUnmatched: unmatched,
      sheets: sheetSummary,
      sheetsSkipped: skipped,
    });
  } catch (err) {
    console.error("[excel import] Error:", err);
    next(err);
  }
}

/**
 * GET /api/excel/data
 * Returns unmatched Excel rows (plus optional ?sheetName= filter).
 * Matched data lives on transactions.supplementary_data.
 */
async function getExcelData(req, res, next) {
  try {
    const { sheetName, importId } = req.query;

    let query = supabase
      .from("excel_unmatched_rows")
      .select("id, account_number, row_data, import_id, created_at, sheet_name, track_name")
      .order("created_at", { ascending: false });

    if (sheetName) query = query.eq("sheet_name", sheetName);
    if (importId) query = query.eq("import_id", importId);

    const { data: rows, error } = await query;
    if (error) throw error;

    const formattedData = rows.map((row) => {
      const rowData = row.row_data || {};
      const name =
        rowData.studentName ||
        rowData.name ||
        rowData.Name ||
        rowData.NAME ||
        rowData["Student Name"] ||
        "";
      const amount =
        typeof rowData.amount === "number"
          ? rowData.amount
          : Number(String(rowData.amount || rowData["TERM 3"] || 0).replace(/,/g, "")) || 0;

      return {
        id: row.id,
        accountNumber: row.account_number || "",
        name,
        amount,
        notes: rowData.notes || rowData.Notes || null,
        category: rowData.category || rowData.Category || null,
        sheetName: row.sheet_name || rowData.sheetName || null,
        trackName: row.track_name || rowData.trackName || null,
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

/**
 * GET /api/excel/imports
 * Lists import batches so clients can delete by id.
 */
async function listExcelImports(req, res, next) {
  try {
    const { data, error } = await supabase
      .from("excel_imports")
      .select("id, file_name, rows_total, rows_matched, rows_unmatched, imported_at, details")
      .order("imported_at", { ascending: false });

    if (error) throw error;

    res.json({
      success: true,
      imports: (data || []).map((row) => ({
        id: row.id,
        fileName: row.file_name,
        rowsTotal: row.rows_total,
        rowsMatched: row.rows_matched,
        rowsUnmatched: row.rows_unmatched,
        importedAt: row.imported_at,
        details: row.details,
      })),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/excel/sheets
 * Lists distinct sheet names present in unmatched rows (for delete UI).
 */
async function listExcelSheets(req, res, next) {
  try {
    const { data, error } = await supabase
      .from("excel_unmatched_rows")
      .select("sheet_name")
      .not("sheet_name", "is", null);

    if (error) throw error;

    const counts = {};
    for (const row of data || []) {
      const name = row.sheet_name;
      if (!name) continue;
      counts[name] = (counts[name] || 0) + 1;
    }

    const sheets = Object.entries(counts)
      .map(([sheetName, rowCount]) => ({ sheetName, rowCount }))
      .sort((a, b) => a.sheetName.localeCompare(b.sheetName));

    res.json({ success: true, sheets });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/excel/import/:id
 * Deletes an Excel import batch and its unmatched rows.
 * Also clears supplementary_data on transactions linked from that import's unmatched path
 * is not enough — matched data is on transactions. We clear any tx whose
 * supplementary_data.sheetName appears only in this import's details when possible;
 * primarily we wipe unmatched rows + the import record.
 */
async function deleteExcelImport(req, res, next) {
  try {
    const { id } = req.params;

    // Clear matched supplementary_data that came from this import's sheets when
    // the row still carries sheetName (written by the fixed importer).
    const { data: importRow } = await supabase
      .from("excel_imports")
      .select("id, details")
      .eq("id", id)
      .maybeSingle();

    if (!importRow) {
      return res.status(404).json({ success: false, message: "Import not found" });
    }

    const sheetNames = importRow.details?.sheetsProcessed || [];
    let clearedTransactions = 0;

    if (sheetNames.length > 0) {
      const { data: txs, error: txErr } = await supabase
        .from("transactions")
        .select("id, supplementary_data")
        .not("supplementary_data", "is", null);

      if (txErr) throw txErr;

      for (const tx of txs || []) {
        const sheet = tx.supplementary_data?.sheetName;
        if (sheet && sheetNames.includes(sheet)) {
          const { error: clearErr } = await supabase
            .from("transactions")
            .update({ supplementary_data: null, linked_at: null })
            .eq("id", tx.id);
          if (clearErr) throw clearErr;
          clearedTransactions++;
        }
      }
    }

    const { error: deleteRowsError } = await supabase
      .from("excel_unmatched_rows")
      .delete()
      .eq("import_id", id);

    if (deleteRowsError) throw deleteRowsError;

    const { error: deleteImportError } = await supabase
      .from("excel_imports")
      .delete()
      .eq("id", id);

    if (deleteImportError) throw deleteImportError;

    res.json({
      success: true,
      message: "Excel import deleted successfully",
      clearedTransactions,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/excel/sheets/:sheetName
 * Deletes all unmatched rows for a workbook sheet (class/stream name),
 * and clears matching supplementary_data on transactions.
 */
async function deleteExcelSheet(req, res, next) {
  try {
    const sheetName = decodeURIComponent(req.params.sheetName || "").trim();
    if (!sheetName) {
      return res.status(400).json({ success: false, message: "sheetName is required" });
    }

    const { data: deletedRows, error: deleteRowsError } = await supabase
      .from("excel_unmatched_rows")
      .delete()
      .eq("sheet_name", sheetName)
      .select("id");

    if (deleteRowsError) throw deleteRowsError;

    let clearedTransactions = 0;
    const { data: txs, error: txErr } = await supabase
      .from("transactions")
      .select("id, supplementary_data")
      .not("supplementary_data", "is", null);

    if (txErr) throw txErr;

    for (const tx of txs || []) {
      const sheet = tx.supplementary_data?.sheetName;
      if (sheet === sheetName) {
        const { error: clearErr } = await supabase
          .from("transactions")
          .update({ supplementary_data: null, linked_at: null })
          .eq("id", tx.id);
        if (clearErr) throw clearErr;
        clearedTransactions++;
      }
    }

    res.json({
      success: true,
      message: `Deleted Excel sheet "${sheetName}"`,
      deletedUnmatchedRows: (deletedRows || []).length,
      clearedTransactions,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/excel/debug
 * Analyze Excel structure without writing to the DB.
 */
async function debugExcel(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    const { sheets, skipped } = parseWorkbookSheets(workbook);

    const sheetData = sheets.map((s) => ({
      sheetName: s.sheetName,
      headerRowIndex: s.headerRowIndex,
      columns: s.columns,
      rowCount: s.rows.length,
      sampleRows: s.rows.slice(0, 3).map((r) => ({
        accountNumber: r.accountNumber,
        studentName: r.studentName,
        trackName: r.trackName,
        amount: r.amount,
        rawRow: r.rawRow,
      })),
    }));

    // Also show naive sheet_to_json view for the first sheet (helps spot header issues)
    const firstSheetName = workbook.SheetNames[0];
    let naiveFirstSheet = null;
    if (firstSheetName) {
      const naiveRows = XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], { defval: null });
      naiveFirstSheet = {
        sheetName: firstSheetName,
        note: "Naive parse assuming row 1 is header (old broken behaviour)",
        rowCount: naiveRows.length,
        columns: naiveRows[0] ? Object.keys(naiveRows[0]) : [],
        sampleRows: naiveRows.slice(0, 2),
      };
    }

    res.json({
      success: true,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      sheetCount: workbook.SheetNames.length,
      sheets: sheetData,
      sheetsSkipped: skipped,
      naiveFirstSheet,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  importExcel,
  getExcelData,
  listExcelImports,
  listExcelSheets,
  deleteExcelImport,
  deleteExcelSheet,
  debugExcel,
};
