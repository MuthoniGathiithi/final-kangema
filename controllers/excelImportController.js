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
    "ref",
    "ref no",
    "refno",
    "bill ref",
    "billref",
    "bill ref number",
    "billrefnumber",
    "adm",
    "adm ",
    "admission",
    "admission no",
    "admission number",
  ];
  const keys = Object.keys(row);
  console.log("[extractAccountNumber] Available keys:", keys);
  for (const key of keys) {
    const normalizedKey = key.trim().toLowerCase();
    if (candidates.includes(normalizedKey)) {
      const value = String(row[key]).trim();
      console.log(`[extractAccountNumber] Found account number in column "${key}": ${value}`);
      return value;
    }
  }
  // Try to find by column position (ADM is usually the second column)
  const keysArray = Object.keys(row);
  if (keysArray.length >= 2) {
    const secondKey = keysArray[1];
    const value = String(row[secondKey]).trim();
    if (value && !isNaN(Number(value))) {
      console.log(`[extractAccountNumber] Using second column "${secondKey}" as account number: ${value}`);
      return value;
    }
  }
  console.log("[extractAccountNumber] No account number column found");
  return null;
}

/**
 * Extracts track name from row data
 */
function extractTrackName(row, sheetName) {
  const candidates = [
    "track",
    "track name",
    "track_name",
    "trackname",
    "name",
    "student name",
    "student_name",
    "studentname",
    "full name",
    "full_name",
    "fullname",
  ];
  const keys = Object.keys(row);
  console.log("[extractTrackName] Available keys:", keys);
  console.log("[extractTrackName] Sheet name (fallback):", sheetName);
  
  for (const key of keys) {
    const normalizedKey = key.trim().toLowerCase();
    if (candidates.includes(normalizedKey)) {
      const value = String(row[key]).trim();
      console.log(`[extractTrackName] Found track name in column "${key}": ${value}`);
      return value;
    }
  }
  
  // If no column found, use the sheet name as track name
  if (sheetName) {
    console.log(`[extractTrackName] Using sheet name as track name: ${sheetName}`);
    return sheetName;
  }
  
  console.log("[extractTrackName] No track name column found");
  return null;
}

/**
 * Extracts student name from row data
 */
function extractStudentName(row, sheetName) {
  const candidates = [
    "name",
    "student name",
    "student_name",
    "studentname",
    "full name",
    "full_name",
    "fullname",
  ];
  const keys = Object.keys(row);
  console.log("[extractStudentName] Available keys:", keys);
  console.log("[extractStudentName] Sheet name:", sheetName);
  
  for (const key of keys) {
    const normalizedKey = key.trim().toLowerCase();
    if (candidates.includes(normalizedKey)) {
      const value = String(row[key]).trim();
      console.log(`[extractStudentName] Found student name in column "${key}": ${value}`);
      return value;
    }
  }
  
  // Try to find column that contains the sheet name (e.g., "GRADE 10 - KENYATTA")
  for (const key of keys) {
    if (key.includes(sheetName) || key.includes("GRADE")) {
      const value = String(row[key]).trim();
      if (value && value !== "NAME") {
        console.log(`[extractStudentName] Found student name in sheet-named column "${key}": ${value}`);
        return value;
      }
    }
  }
  
  console.log("[extractStudentName] No student name column found");
  return null;
}

/**
 * Extracts amount from row data - handles currency symbols, commas, and various formats
 */
function extractAmount(row) {
  const candidates = [
    "amount",
    "ksh",
    "kes",
    "value",
    "total",
    "fee",
    "payment",
    "balance",
    "term 3",
    "term 1",
    "term 2",
    "term",
    "0.p.bal",
    "p.p.bal",
    "c.p.bal",
  ];
  const keys = Object.keys(row);
  console.log("[extractAmount] Available keys:", keys);
  for (const key of keys) {
    const normalizedKey = key.trim().toLowerCase();
    if (candidates.includes(normalizedKey)) {
      let value = row[key];
      console.log(`[extractAmount] Found amount column "${key}" with raw value:`, value);
      
      // Handle null/undefined
      if (value === null || value === undefined || value === "") {
        console.log("[extractAmount] Value is null/undefined/empty, returning 0");
        return 0;
      }
      
      // Convert to string and clean
      value = String(value).trim();
      
      // Remove currency symbols and commas
      value = value.replace(/[Kk][Ss][Hh]/g, "");
      value = value.replace(/[Kk][Ee][Ss]/g, "");
      value = value.replace(/[Kk][Ss]/g, "");
      value = value.replace(/[$£€]/g, "");
      value = value.replace(/,/g, "");
      value = value.trim();
      
      const parsed = parseFloat(value);
      const result = isNaN(parsed) ? 0 : parsed;
      console.log(`[extractAmount] Parsed amount: ${result}`);
      return result;
    }
  }
  
  // Try to find by column position (TERM 3 is usually the 6th column, index 5)
  const keysArray = Object.keys(row);
  if (keysArray.length >= 6) {
    const sixthKey = keysArray[5];
    const value = row[sixthKey];
    if (value !== null && value !== undefined && value !== "") {
      const parsed = parseFloat(String(value).replace(/,/g, ""));
      if (!isNaN(parsed) && parsed > 0) {
        console.log(`[extractAmount] Using sixth column "${sixthKey}" as amount: ${parsed}`);
        return parsed;
      }
    }
  }
  
  console.log("[extractAmount] No amount column found, returning 0");
  return 0;
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
    console.log("[excel import] Buffer length:", req.file.buffer.length);

    const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
    console.log("[excel import] Workbook loaded successfully");
    const sheetName = workbook.SheetNames[0];
    console.log("[excel import] Sheet name:", sheetName);
    console.log("[excel import] All sheet names:", workbook.SheetNames);
    
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
    console.log("[excel import] Total rows parsed:", rows.length);
    
    if (rows.length > 0) {
      console.log("[excel import] Sample row keys:", Object.keys(rows[0]));
      console.log("[excel import] Sample row data:", JSON.stringify(rows[0], null, 2));
      
      // Log first 3 rows for debugging
      console.log("[excel import] First 3 rows:");
      for (let i = 0; i < Math.min(3, rows.length); i++) {
        console.log(`[excel import] Row ${i}:`, JSON.stringify(rows[i], null, 2));
      }
    } else {
      console.log("[excel import] WARNING: No rows parsed from Excel file");
    }

    let matched = 0;
    let unmatched = 0;
    const unmatchedRows = [];

    // Log the import batch first
    const { data: importRow, error: importError } = await supabase
      .from("excel_imports")
      .insert({ file_name: req.file.originalname, rows_total: rows.length })
      .select()
      .single();

    if (importError) {
      console.error("[excel import] Failed to create import record:", importError);
      throw importError;
    }
    
    console.log("[excel import] Import record created with ID:", importRow.id);

    for (const row of rows) {
      const accountNumber = extractAccountNumber(row);
      const trackName = extractTrackName(row, sheetName);
      const studentName = extractStudentName(row, sheetName);
      const amount = extractAmount(row);

      // Add student name to row data
      const enrichedRow = { ...row, studentName };

      if (!accountNumber) {
        unmatched++;
        unmatchedRows.push({ 
          import_id: importRow.id, 
          account_number: null, 
          row_data: enrichedRow,
          sheet_name: sheetName,
          track_name: trackName
        });
        console.log(`[excel import] Row unmatched: no account number. Track: ${trackName}, Student: ${studentName}, Amount: ${amount}`);
        continue;
      }

      // Find transaction(s) with this account number
      const { data: existing, error: findError } = await supabase
        .from("transactions")
        .select("id")
        .eq("account_number", accountNumber);

      if (findError) {
        console.error("[excel import] Error finding transactions:", findError);
        throw findError;
      }

      if (!existing || existing.length === 0) {
        unmatched++;
        unmatchedRows.push({ 
          import_id: importRow.id, 
          account_number: accountNumber, 
          row_data: enrichedRow,
          sheet_name: sheetName,
          track_name: trackName
        });
        console.log(`[excel import] Row unmatched: no matching transaction. Account: ${accountNumber}, Track: ${trackName}, Student: ${studentName}, Amount: ${amount}`);
        continue;
      }

      // Merge supplementary data into every matching transaction
      for (const tx of existing) {
        const { error: updateError } = await supabase
          .from("transactions")
          .update({ supplementary_data: enrichedRow, linked_at: new Date().toISOString() })
          .eq("id", tx.id);

        if (updateError) {
          console.error("[excel import] Error updating transaction:", updateError);
          throw updateError;
        }
      }
      matched++;
      console.log(`[excel import] Row matched: Account: ${accountNumber}, Track: ${trackName}, Student: ${studentName}, Amount: ${amount}, Matched ${existing.length} transaction(s)`);
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

    console.log("[excel import] Import complete. Total:", rows.length, ", Matched:", matched, ", Unmatched:", unmatched);
    console.log("========== EXCEL IMPORT END ==========");

    res.json({
      success: true,
      importId: importRow.id,
      rowsTotal: rows.length,
      rowsMatched: matched,
      rowsUnmatched: unmatched,
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

module.exports = { importExcel, getExcelData, debugExcel };