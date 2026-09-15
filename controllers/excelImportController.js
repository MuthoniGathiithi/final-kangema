const XLSX = require("xlsx");
const supabase = require("../config/supabase");

/**
 * Extracts column value by header name (case-insensitive)
 */
function extractColumn(row, headerName) {
  const keys = Object.keys(row);
  for (const key of keys) {
    if (key.trim().toLowerCase() === headerName.toLowerCase()) {
      return row[key];
    }
  }
  return null;
}

/**
 * Extracts account number (ADM column)
 */
function extractAccountNumber(row) {
  const value = extractColumn(row, "ADM");
  if (value !== null && value !== undefined && value !== "") {
    return String(value).trim();
  }
  return null;
}

/**
 * Extracts student name (NAME column)
 */
function extractStudentName(row) {
  const value = extractColumn(row, "NAME");
  if (value !== null && value !== undefined && value !== "") {
    return String(value).trim();
  }
  return null;
}

/**
 * Extracts contact (CONTACT column)
 */
function extractContact(row) {
  const value = extractColumn(row, "CONTACT");
  if (value !== null && value !== undefined && value !== "") {
    return String(value).trim();
  }
  return null;
}

/**
 * Extracts numeric value from column
 */
function extractNumeric(row, headerName) {
  const value = extractColumn(row, headerName);
  if (value === null || value === undefined || value === "") {
    return 0;
  }
  const parsed = parseFloat(String(value).replace(/,/g, ""));
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Extracts opening balance (O.P.BAL)
 */
function extractOpeningBalance(row) {
  return extractNumeric(row, "O.P.BAL");
}

/**
 * Extracts previous balance (P.P.BAL)
 */
function extractPreviousBalance(row) {
  return extractNumeric(row, "P.P.BAL");
}

/**
 * Extracts current balance (C.P.BAL)
 */
function extractCurrentBalance(row) {
  return extractNumeric(row, "C.P.BAL");
}

/**
 * Extracts term 3 amount (TERM 3)
 */
function extractTerm3Amount(row) {
  return extractNumeric(row, "TERM 3");
}

/**
 * Extracts term 1 amount (TERM 1 or TRM 1)
 */
function extractTerm1Amount(row) {
  let value = extractNumeric(row, "TERM 1");
  if (value === 0) {
    value = extractNumeric(row, "TRM 1");
  }
  return value;
}

/**
 * POST /api/excel/import
 * multipart/form-data with a single field "file" (.xlsx or .xls)
 */
async function importExcel(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded (field name must be 'file')" });
    }

    console.log("========== EXCEL IMPORT START ==========");
    console.log("[excel import] File received:", req.file.originalname);
    console.log("[excel import] File size:", req.file.size);
    console.log("[excel import] MIME type:", req.file.mimetype);

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    console.log("[excel import] Workbook loaded successfully");
    const sheetNames = workbook.SheetNames;
    console.log("[excel import] All sheet names:", sheetNames);

    let totalRows = 0;
    let studentsInserted = 0;
    let studentsUpdated = 0;
    let transactionsMatched = 0;
    let unmatchedRows = [];

    // Log the import batch first
    const { data: importRow, error: importError } = await supabase
      .from("excel_imports")
      .insert({ file_name: req.file.originalname, rows_total: 0 })
      .select()
      .single();

    if (importError) {
      console.error("[excel import] Failed to create import record:", importError);
      throw importError;
    }

    console.log("[excel import] Import record created with ID:", importRow.id);

    // Process each sheet
    for (const sheetName of sheetNames) {
      console.log(`[excel import] Processing sheet: ${sheetName}`);
      const sheet = workbook.Sheets[sheetName];
      
      // Parse with header: 1 (skip first row, use second row as header)
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: null, header: 1 });
      console.log(`[excel import] Sheet "${sheetName}" raw rows: ${rows.length}`);

      if (rows.length < 2) {
        console.log(`[excel import] Sheet "${sheetName}" has no data rows, skipping`);
        continue;
      }

      // Row 0 is the title row (skip)
      // Row 1 is the header row
      const headers = rows[1];
      console.log(`[excel import] Sheet "${sheetName}" headers:`, headers);

      // Data rows start from row 2
      const dataRows = rows.slice(2);
      console.log(`[excel import] Sheet "${sheetName}" data rows: ${dataRows.length}`);

      // Convert data rows to objects using headers
      const parsedRows = dataRows.map(row => {
        const obj = {};
        headers.forEach((header, index) => {
          obj[header] = row[index];
        });
        return obj;
      });

      totalRows += parsedRows.length;

      for (const row of parsedRows) {
        const admissionNumber = extractAccountNumber(row);
        const fullName = extractStudentName(row);
        const contact = extractContact(row);
        const openingBalance = extractOpeningBalance(row);
        const previousBalance = extractPreviousBalance(row);
        const currentBalance = extractCurrentBalance(row);
        const term3Amount = extractTerm3Amount(row);
        const term1Amount = extractTerm1Amount(row);

        console.log(`[excel import] Processing row - ADM: ${admissionNumber}, Name: ${fullName}`);

        // Skip rows without admission number
        if (!admissionNumber) {
          console.log(`[excel import] Skipping row - no admission number`);
          continue;
        }

        // Upsert into students table
        const { data: studentData, error: studentError } = await supabase
          .from("students")
          .upsert({
            admission_number: admissionNumber,
            full_name: fullName,
            contact: contact,
            opening_balance: openingBalance,
            previous_balance: previousBalance,
            current_balance: currentBalance,
            term_3_amount: term3Amount,
            term_1_amount: term1Amount,
            track_name: sheetName,
            sheet_name: sheetName,
          }, {
            onConflict: "admission_number",
            ignoreDuplicates: false
          })
          .select()
          .single();

        if (studentError) {
          console.error("[excel import] Error upserting student:", studentError);
        } else {
          if (studentData.created_at === studentData.updated_at) {
            studentsInserted++;
          } else {
            studentsUpdated++;
          }
        }

        // Try to match with transactions
        const { data: existingTx, error: findError } = await supabase
          .from("transactions")
          .select("id")
          .eq("account_number", admissionNumber);

        if (findError) {
          console.error("[excel import] Error finding transactions:", findError);
        } else if (!existingTx || existingTx.length === 0) {
          // No matching transaction - add to unmatched rows
          unmatchedRows.push({
            import_id: importRow.id,
            account_number: admissionNumber,
            row_data: row,
            sheet_name: sheetName,
            track_name: sheetName
          });
          console.log(`[excel import] No matching transaction for ADM: ${admissionNumber}`);
        } else {
          // Match found - update transaction with supplementary data
          for (const tx of existingTx) {
            const { error: updateError } = await supabase
              .from("transactions")
              .update({
                supplementary_data: {
                  admission_number: admissionNumber,
                  full_name: fullName,
                  contact: contact,
                  opening_balance: openingBalance,
                  previous_balance: previousBalance,
                  current_balance: currentBalance,
                  term_3_amount: term3Amount,
                  term_1_amount: term1Amount,
                  track_name: sheetName,
                  sheet_name: sheetName,
                },
                linked_at: new Date().toISOString()
              })
              .eq("id", tx.id);

            if (updateError) {
              console.error("[excel import] Error updating transaction:", updateError);
            } else {
              transactionsMatched++;
            }
          }
          console.log(`[excel import] Matched ${existingTx.length} transaction(s) for ADM: ${admissionNumber}`);
        }
      }
    }

    // Insert unmatched rows
    if (unmatchedRows.length > 0) {
      const { error: unmatchedInsertError } = await supabase
        .from("excel_unmatched_rows")
        .insert(unmatchedRows);
      if (unmatchedInsertError) console.error("[excel import] Failed to log unmatched rows:", unmatchedInsertError);
    }

    // Update import record with totals
    await supabase
      .from("excel_imports")
      .update({
        rows_total: totalRows,
        rows_matched: transactionsMatched,
        rows_unmatched: unmatchedRows.length
      })
      .eq("id", importRow.id);

    console.log("[excel import] Import complete. Total rows:", totalRows);
    console.log("[excel import] Students inserted:", studentsInserted);
    console.log("[excel import] Students updated:", studentsUpdated);
    console.log("[excel import] Transactions matched:", transactionsMatched);
    console.log("[excel import] Unmatched rows:", unmatchedRows.length);
    console.log("========== EXCEL IMPORT END ==========");

    res.json({
      success: true,
      importId: importRow.id,
      rowsTotal: totalRows,
      studentsInserted,
      studentsUpdated,
      transactionsMatched,
      rowsUnmatched: unmatchedRows.length,
    });
  } catch (err) {
    console.error("[excel import] Error:", err);
    console.error("[excel import] Error stack:", err.stack);
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
      .select("id, account_number, row_data, import_id, created_at, sheet_name, track_name")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const formattedData = rows.map((row) => {
      const rowData = row.row_data || {};
      const amount = extractAmount(rowData);
      
      return {
        id: row.id,
        accountNumber: row.account_number || "",
        name: rowData.name || rowData.Name || "",
        amount: amount,
        notes: rowData.notes || rowData.Notes || null,
        category: rowData.category || rowData.Category || null,
        sheetName: row.sheet_name || null,
        trackName: row.track_name || null,
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
 * GET /api/excel/sheets
 * Lists distinct sheet names from unmatched Excel rows (for delete UI).
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
 * DELETE /api/excel/sheets/:sheetName
 * Deletes all unmatched rows for that sheet, and clears matching
 * supplementary_data on transactions linked from that sheet.
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

    if (deleteRowsError) {
      console.error("[deleteExcelSheet] Error deleting unmatched rows:", deleteRowsError);
      throw deleteRowsError;
    }

    let clearedTransactions = 0;
    const { data: txs, error: txErr } = await supabase
      .from("transactions")
      .select("id, supplementary_data")
      .not("supplementary_data", "is", null);

    if (txErr) throw txErr;

    for (const tx of txs || []) {
      const data = tx.supplementary_data || {};
      const matches =
        data.sheetName === sheetName ||
        data.trackName === sheetName ||
        data.track_name === sheetName;

      if (!matches) continue;

      const { error: clearErr } = await supabase
        .from("transactions")
        .update({ supplementary_data: null, linked_at: null })
        .eq("id", tx.id);

      if (clearErr) throw clearErr;
      clearedTransactions++;
    }

    console.log(
      `[deleteExcelSheet] Deleted sheet "${sheetName}": unmatched=${(deletedRows || []).length}, clearedTx=${clearedTransactions}`
    );

    res.json({
      success: true,
      message: `Deleted Excel sheet "${sheetName}"`,
      deletedUnmatchedRows: (deletedRows || []).length,
      clearedTransactions,
    });
  } catch (err) {
    console.error("[deleteExcelSheet] Error:", err);
    next(err);
  }
}

/**
 * DELETE /api/excel/import/:id
 * Deletes an Excel import and all its associated unmatched rows
 */
async function deleteExcelImport(req, res, next) {
  try {
    const { id } = req.params;

    // First delete unmatched rows associated with this import
    const { error: deleteRowsError } = await supabase
      .from("excel_unmatched_rows")
      .delete()
      .eq("import_id", id);

    if (deleteRowsError) {
      console.error("[deleteExcelImport] Error deleting unmatched rows:", deleteRowsError);
      throw deleteRowsError;
    }

    // Then delete the import record
    const { error: deleteImportError } = await supabase
      .from("excel_imports")
      .delete()
      .eq("id", id);

    if (deleteImportError) {
      console.error("[deleteExcelImport] Error deleting import:", deleteImportError);
      throw deleteImportError;
    }

    console.log(`[deleteExcelImport] Successfully deleted import ${id}`);

    res.json({
      success: true,
      message: "Excel import deleted successfully",
    });
  } catch (err) {
    console.error("[deleteExcelImport] Error:", err);
    next(err);
  }
}

/**
 * POST /api/excel/debug
 * Debug endpoint to analyze Excel file structure without importing
 * Returns the parsed structure for debugging
 */
async function debugExcel(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: "No file uploaded" });
    }

    console.log("========== EXCEL DEBUG START ==========");
    console.log("[debug] File received:", req.file.originalname);
    console.log("[debug] File size:", req.file.size);
    console.log("[debug] MIME type:", req.file.mimetype);

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    console.log("[debug] Workbook loaded successfully");
    
    const sheetNames = workbook.SheetNames;
    console.log("[debug] All sheet names:", sheetNames);
    
    const sheetData = [];
    
    for (const sheetName of sheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
      
      console.log(`[debug] Sheet "${sheetName}": ${rows.length} rows`);
      
      if (rows.length > 0) {
        console.log(`[debug] Sheet "${sheetName}" keys:`, Object.keys(rows[0]));
        console.log(`[debug] Sheet "${sheetName}" first row:`, JSON.stringify(rows[0], null, 2));
        
        sheetData.push({
          sheetName,
          rowCount: rows.length,
          columns: Object.keys(rows[0]),
          sampleRows: rows.slice(0, 3),
        });
      } else {
        sheetData.push({
          sheetName,
          rowCount: 0,
          columns: [],
          sampleRows: [],
        });
      }
    }
    
    console.log("========== EXCEL DEBUG END ==========");

    res.json({
      success: true,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      sheetCount: sheetNames.length,
      sheets: sheetData,
    });
  } catch (err) {
    console.error("[debug] Error:", err);
    console.error("[debug] Error stack:", err.stack);
    next(err);
  }
}

module.exports = {
  importExcel,
  getExcelData,
  listExcelSheets,
  deleteExcelSheet,
  deleteExcelImport,
  debugExcel,
};
