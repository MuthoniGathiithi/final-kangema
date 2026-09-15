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
 * Extracts CPA amount (CPA column)
 */
function extractCpaAmount(row) {
  return extractNumeric(row, "CPA");
}

/**
 * Extracts TERM 2 amount (TERM 2 column)
 */
function extractTerm2Amount(row) {
  return extractNumeric(row, "TERM 2");
}

/**
 * Extracts SIGN column value
 */
function extractSign(row) {
  const value = extractColumn(row, "SIGN");
  if (value !== null && value !== undefined && value !== "") {
    return String(value).trim();
  }
  return null;
}

/**
 * POST /api/excel/import
 * multipart/form-data with a single field "file" (.xlsx or .xls)
 */
async function importExcel(req, res, next) {
  const startTime = Date.now();
  let responseSent = false;
  const MAX_EXECUTION_TIME = 55000; // 55 seconds (Vercel timeout is ~60s)
  const BATCH_SIZE = 100; // Process rows in batches for bulk upserts

  // Set up timeout handler
  const timeoutId = setTimeout(() => {
    if (!responseSent) {
      console.error("[excel import] TIMEOUT: Execution exceeded maximum time");
      console.error("[excel import] Duration:", Date.now() - startTime, "ms");
      responseSent = true;
      res.status(408).json({ 
        success: false, 
        message: "Import timeout: file too large or processing took too long",
        duration: Date.now() - startTime
      });
    }
  }, MAX_EXECUTION_TIME);

  try {
    if (!req.file) {
      clearTimeout(timeoutId);
      console.log("[excel import] ERROR: No file uploaded");
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
    let allStudentRecords = [];
    let allAdmissionNumbers = [];

    // Log the import batch first
    console.log("[excel import] Creating import record...");
    const { data: importRow, error: importError } = await supabase
      .from("excel_imports")
      .insert({ file_name: req.file.originalname, rows_total: 0 })
      .select()
      .single();

    if (importError) {
      clearTimeout(timeoutId);
      console.error("[excel import] ERROR: Failed to create import record:", importError);
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
      console.log(`[excel import] Sheet "${sheetName}" parsed ${parsedRows.length} rows`);

      // Collect all student records for bulk upsert
      for (const row of parsedRows) {
        const admissionNumber = extractAccountNumber(row);
        const fullName = extractStudentName(row);
        const contact = extractContact(row);
        const openingBalance = extractOpeningBalance(row);
        const previousBalance = extractPreviousBalance(row);
        const currentBalance = extractCurrentBalance(row);
        const term3Amount = extractTerm3Amount(row);
        const term1Amount = extractTerm1Amount(row);
        const term2Amount = extractTerm2Amount(row);
        const cpaAmount = extractCpaAmount(row);
        const sign = extractSign(row);

        // Skip rows without admission number
        if (!admissionNumber) {
          continue;
        }

        allStudentRecords.push({
          admission_number: admissionNumber,
          full_name: fullName,
          contact: contact,
          opening_balance: openingBalance,
          previous_balance: previousBalance,
          current_balance: currentBalance,
          term_3_amount: term3Amount,
          term_1_amount: term1Amount,
          term_2_amount: term2Amount,
          cpa_amount: cpaAmount,
          sign: sign,
          track_name: sheetName,
          sheet_name: sheetName,
        });

        allAdmissionNumbers.push(admissionNumber);
      }
      console.log(`[excel import] Sheet "${sheetName}" collected ${allStudentRecords.length} student records`);
    }

    console.log(`[excel import] Total student records to upsert: ${allStudentRecords.length}`);

    // Bulk upsert students in batches
    console.log("[excel import] Starting bulk student upserts...");
    for (let i = 0; i < allStudentRecords.length; i += BATCH_SIZE) {
      const batch = allStudentRecords.slice(i, i + BATCH_SIZE);
      console.log(`[excel import] Upserting batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allStudentRecords.length / BATCH_SIZE)} (${batch.length} records)`);
      
      const batchStartTime = Date.now();
      
      const { data: upsertedData, error: upsertError } = await supabase
        .from("students")
        .upsert(batch, {
          onConflict: "admission_number",
          ignoreDuplicates: false
        });

      if (upsertError) {
        console.error("[excel import] ERROR in bulk upsert:", upsertError);
      } else {
        // Count inserted vs updated by checking if records were returned
        if (upsertedData && upsertedData.length > 0) {
          studentsInserted += upsertedData.length;
        }
      }
      
      const batchDuration = Date.now() - batchStartTime;
      console.log(`[excel import] Batch upsert completed in ${batchDuration}ms`);
    }

    console.log("[excel import] Bulk student upserts completed");

    // Get existing students to determine insert vs update counts
    const { data: existingStudents, error: existingError } = await supabase
      .from("students")
      .select("admission_number")
      .in("admission_number", allAdmissionNumbers);

    if (existingError) {
      console.error("[excel import] ERROR fetching existing students:", existingError);
    } else {
      const existingSet = new Set((existingStudents || []).map(s => s.admission_number));
      studentsUpdated = allAdmissionNumbers.length - existingSet.size;
      studentsInserted = existingSet.size;
      console.log(`[excel import] Students inserted: ${studentsInserted}, updated: ${studentsUpdated}`);
    }

    // Bulk query for all matching transactions
    console.log("[excel import] Querying matching transactions in bulk...");
    const { data: allTransactions, error: txError } = await supabase
      .from("transactions")
      .select("id, account_number")
      .in("account_number", allAdmissionNumbers);

    if (txError) {
      console.error("[excel import] ERROR querying transactions:", txError);
    } else {
      console.log(`[excel import] Found ${allTransactions?.length || 0} matching transactions`);

      // Group transactions by account_number for efficient matching
      const txByAccount = new Map();
      for (const tx of allTransactions || []) {
        if (!txByAccount.has(tx.account_number)) {
          txByAccount.set(tx.account_number, []);
        }
        txByAccount.get(tx.account_number).push(tx);
      }

      // Match students with transactions and prepare updates
      const transactionUpdates = [];
      const matchedAdmissionNumbers = new Set();

      for (const studentRecord of allStudentRecords) {
        const admissionNumber = studentRecord.admission_number;
        const matchingTxs = txByAccount.get(admissionNumber);

        if (!matchingTxs || matchingTxs.length === 0) {
          // No matching transaction - add to unmatched rows
          unmatchedRows.push({
            import_id: importRow.id,
            account_number: admissionNumber,
            row_data: studentRecord,
            sheet_name: studentRecord.sheet_name,
            track_name: studentRecord.track_name
          });
        } else {
          matchedAdmissionNumbers.add(admissionNumber);
          // Prepare transaction updates
          for (const tx of matchingTxs) {
            transactionUpdates.push({
              id: tx.id,
              supplementary_data: {
                admission_number: admissionNumber,
                full_name: studentRecord.full_name,
                contact: studentRecord.contact,
                opening_balance: studentRecord.opening_balance,
                previous_balance: studentRecord.previous_balance,
                current_balance: studentRecord.current_balance,
                term_3_amount: studentRecord.term_3_amount,
                term_1_amount: studentRecord.term_1_amount,
                track_name: studentRecord.track_name,
                sheet_name: studentRecord.sheet_name,
              },
              linked_at: new Date().toISOString()
            });
          }
        }
      }

      transactionsMatched = matchedAdmissionNumbers.size;
      console.log(`[excel import] Matched ${transactionsMatched} students with transactions`);
      console.log(`[excel import] Unmatched: ${unmatchedRows.length}`);

      // Batch transaction updates using Promise.all for parallel execution
      if (transactionUpdates.length > 0) {
        console.log(`[excel import] Updating ${transactionUpdates.length} transactions in parallel...`);
        const updatePromises = transactionUpdates.map(update => 
          supabase
            .from("transactions")
            .update({
              supplementary_data: update.supplementary_data,
              linked_at: update.linked_at
            })
            .eq("id", update.id)
        );

        const results = await Promise.allSettled(updatePromises);
        const successfulUpdates = results.filter(r => r.status === 'fulfilled').length;
        console.log(`[excel import] Transaction updates completed: ${successfulUpdates}/${transactionUpdates.length} successful`);
      }
    }

    // Insert unmatched rows in bulk
    console.log(`[excel import] Inserting ${unmatchedRows.length} unmatched rows in bulk...`);
    if (unmatchedRows.length > 0) {
      const { error: unmatchedInsertError } = await supabase
        .from("excel_unmatched_rows")
        .insert(unmatchedRows);
      if (unmatchedInsertError) {
        console.error("[excel import] ERROR: Failed to log unmatched rows:", unmatchedInsertError);
      } else {
        console.log("[excel import] Unmatched rows inserted successfully");
      }
    }

    // Update import record with totals
    console.log("[excel import] Updating import record with totals...");
    const { error: updateError } = await supabase
      .from("excel_imports")
      .update({
        rows_total: totalRows,
        rows_matched: transactionsMatched,
        rows_unmatched: unmatchedRows.length
      })
      .eq("id", importRow.id);

    if (updateError) {
      console.error("[excel import] ERROR: Failed to update import record:", updateError);
    } else {
      console.log("[excel import] Import record updated successfully");
    }

    clearTimeout(timeoutId);
    const duration = Date.now() - startTime;
    console.log("[excel import] Import complete. Duration:", duration, "ms");
    console.log("[excel import] Total rows:", totalRows);
    console.log("[excel import] Students inserted:", studentsInserted);
    console.log("[excel import] Students updated:", studentsUpdated);
    console.log("[excel import] Transactions matched:", transactionsMatched);
    console.log("[excel import] Unmatched rows:", unmatchedRows.length);
    console.log("========== EXCEL IMPORT END ==========");

    if (!responseSent) {
      responseSent = true;
      console.log("[excel import] Preparing final response...");
      console.log("[excel import] Import completed successfully");
      console.log("[excel import] Sending response 200 to client...");
      const response = {
        success: true,
        importId: importRow.id,
        rowsTotal: totalRows,
        studentsInserted,
        studentsUpdated,
        transactionsMatched,
        rowsUnmatched: unmatchedRows.length,
        duration: duration,
      };
      res.status(200).json(response);
      console.log("[excel import] Response sent successfully");
    }
  } catch (err) {
    clearTimeout(timeoutId);
    console.error("[excel import] CATCH ERROR:", err);
    console.error("[excel import] Error message:", err.message);
    console.error("[excel import] Error stack:", err.stack);
    console.error("[excel import] Duration:", Date.now() - startTime, "ms");
    
    if (!responseSent) {
      responseSent = true;
      console.log("[excel import] Sending error response to client...");
      res.status(500).json({ 
        success: false, 
        message: "Import failed", 
        error: err.message,
        duration: Date.now() - startTime
      });
      console.log("[excel import] Error response sent");
    } else {
      console.error("[excel import] ERROR: Response already sent, cannot send error response");
    }
    
    next(err);
  }
}

/**
 * GET /api/excel/data
 * Returns all imported Excel records (unmatched rows)
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
      
      return {
        id: row.id,
        accountNumber: row.account_number || "",
        name: rowData.name || rowData.Name || "",
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
 * GET /api/students
 * Returns all students with full records and matched status
 */
async function getStudents(req, res, next) {
  try {
    const { data: students, error: studentsError } = await supabase
      .from("students")
      .select("*")
      .order("created_at", { ascending: false });

    if (studentsError) throw studentsError;

    // Get all account numbers that have matching transactions
    const { data: transactions, error: txError } = await supabase
      .from("transactions")
      .select("account_number");

    if (txError) throw txError;

    const matchedAccountNumbers = new Set(
      (transactions || []).map(tx => tx.account_number).filter(Boolean)
    );

    // Add matched status to each student
    const studentsWithStatus = (students || []).map(student => ({
      id: student.id,
      admissionNumber: student.admission_number,
      fullName: student.full_name,
      contact: student.contact,
      openingBalance: Number(student.opening_balance) || 0,
      previousBalance: Number(student.previous_balance) || 0,
      currentBalance: Number(student.current_balance) || 0,
      term3Amount: Number(student.term_3_amount) || 0,
      term1Amount: Number(student.term_1_amount) || 0,
      term2Amount: Number(student.term_2_amount) || 0,
      cpaAmount: Number(student.cpa_amount) || 0,
      sign: student.sign,
      trackName: student.track_name,
      sheetName: student.sheet_name,
      matched: matchedAccountNumbers.has(student.admission_number),
      createdAt: student.created_at,
      updatedAt: student.updated_at,
    }));

    res.json({
      success: true,
      students: studentsWithStatus,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/excel/sheets/:sheetName/students
 * Returns students for a specific sheet
 */
async function getStudentsBySheet(req, res, next) {
  try {
    const sheetName = decodeURIComponent(req.params.sheetName || "").trim();
    if (!sheetName) {
      return res.status(400).json({ success: false, message: "sheetName is required" });
    }

    const { data: students, error: studentsError } = await supabase
      .from("students")
      .select("*")
      .eq("sheet_name", sheetName)
      .order("full_name", { ascending: true });

    if (studentsError) throw studentsError;

    // Get all account numbers that have matching transactions
    const { data: transactions, error: txError } = await supabase
      .from("transactions")
      .select("account_number");

    if (txError) throw txError;

    const matchedAccountNumbers = new Set(
      (transactions || []).map(tx => tx.account_number).filter(Boolean)
    );

    const studentsWithStatus = (students || []).map(student => ({
      id: student.id,
      admissionNumber: student.admission_number,
      fullName: student.full_name,
      contact: student.contact,
      openingBalance: Number(student.opening_balance) || 0,
      previousBalance: Number(student.previous_balance) || 0,
      currentBalance: Number(student.current_balance) || 0,
      term3Amount: Number(student.term_3_amount) || 0,
      term1Amount: Number(student.term_1_amount) || 0,
      term2Amount: Number(student.term_2_amount) || 0,
      cpaAmount: Number(student.cpa_amount) || 0,
      sign: student.sign,
      trackName: student.track_name,
      sheetName: student.sheet_name,
      matched: matchedAccountNumbers.has(student.admission_number),
      createdAt: student.created_at,
      updatedAt: student.updated_at,
    }));

    res.json({
      success: true,
      sheetName: sheetName,
      students: studentsWithStatus,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/excel/students/:id
 * Returns complete student detail
 */
async function getStudentById(req, res, next) {
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ success: false, message: "student id is required" });
    }

    const { data: student, error: studentError } = await supabase
      .from("students")
      .select("*")
      .eq("id", id)
      .single();

    if (studentError || !student) {
      return res.status(404).json({ success: false, message: "Student not found" });
    }

    // Get matching transactions
    const { data: transactions, error: txError } = await supabase
      .from("transactions")
      .select("*")
      .eq("account_number", student.admission_number);

    if (txError) throw txError;

    const studentDetail = {
      id: student.id,
      admissionNumber: student.admission_number,
      fullName: student.full_name,
      contact: student.contact,
      openingBalance: Number(student.opening_balance) || 0,
      previousBalance: Number(student.previous_balance) || 0,
      currentBalance: Number(student.current_balance) || 0,
      term3Amount: Number(student.term_3_amount) || 0,
      term1Amount: Number(student.term_1_amount) || 0,
      term2Amount: Number(student.term_2_amount) || 0,
      cpaAmount: Number(student.cpa_amount) || 0,
      sign: student.sign,
      trackName: student.track_name,
      sheetName: student.sheet_name,
      matched: (transactions || []).length > 0,
      transactions: (transactions || []).map(tx => ({
        id: tx.id,
        transactionCode: tx.transaction_code,
        amount: Number(tx.amount) || 0,
        transactionTime: tx.transaction_time,
        source: tx.source,
      })),
      createdAt: student.created_at,
      updatedAt: student.updated_at,
    };

    res.json({
      success: true,
      student: studentDetail,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/excel/sheets
 * Lists distinct sheet names from students table with record counts
 */
async function listExcelSheets(req, res, next) {
  try {
    console.log("[listExcelSheets] Fetching sheets from students table");
    const { data, error } = await supabase
      .from("students")
      .select("sheet_name")
      .not("sheet_name", "is", null);

    if (error) throw error;

    console.log("[listExcelSheets] Raw data from students table:", data?.length || 0, "rows");
    console.log("[listExcelSheets] Sample sheet_names:", data?.slice(0, 5).map(r => r.sheet_name));

    const counts = {};
    for (const row of data || []) {
      const name = row.sheet_name;
      if (!name) continue;
      counts[name] = (counts[name] || 0) + 1;
    }

    console.log("[listExcelSheets] Sheet counts:", counts);

    const sheets = Object.entries(counts)
      .map(([sheetName, rowCount]) => ({ sheetName, rowCount }))
      .sort((a, b) => a.sheetName.localeCompare(b.sheetName));

    console.log("[listExcelSheets] Returning sheets:", sheets);

    res.json({ success: true, sheets });
  } catch (err) {
    console.error("[listExcelSheets] Error:", err);
    next(err);
  }
}

/**
 * DELETE /api/excel/sheets/:sheetName
 * Deletes all students and unmatched rows for that sheet.
 * Does NOT delete matched transactions.
 */
async function deleteExcelSheet(req, res, next) {
  try {
    const sheetName = decodeURIComponent(req.params.sheetName || "").trim();
    if (!sheetName) {
      return res.status(400).json({ success: false, message: "sheetName is required" });
    }

    // Check for matched students before deleting
    const { data: matchedStudents, error: matchError } = await supabase
      .from("students")
      .select("admission_number, full_name")
      .eq("sheet_name", sheetName);

    if (matchError) throw matchError;

    const matchedAdmissionNumbers = [];
    if (matchedStudents && matchedStudents.length > 0) {
      const admissionNumbers = matchedStudents.map(s => s.admission_number);
      const { data: transactions, error: txError } = await supabase
        .from("transactions")
        .select("account_number")
        .in("account_number", admissionNumbers);

      if (txError) throw txError;

      const txAccountNumbers = new Set((transactions || []).map(tx => tx.account_number));
      matchedAdmissionNumbers.push(...matchedStudents
        .filter(s => txAccountNumbers.has(s.admission_number))
        .map(s => ({ admissionNumber: s.admission_number, fullName: s.full_name }))
      );
    }

    // If there are matched students, return warning
    if (matchedAdmissionNumbers.length > 0) {
      return res.json({
        success: false,
        message: "Cannot delete sheet: some students have matched transactions",
        matchedStudents: matchedAdmissionNumbers,
      });
    }

    // Delete unmatched rows for this sheet
    const { data: deletedRows, error: deleteRowsError } = await supabase
      .from("excel_unmatched_rows")
      .delete()
      .eq("sheet_name", sheetName)
      .select("id");

    if (deleteRowsError) {
      console.error("[deleteExcelSheet] Error deleting unmatched rows:", deleteRowsError);
      throw deleteRowsError;
    }

    // Delete students for this sheet
    const { data: deletedStudents, error: deleteStudentsError } = await supabase
      .from("students")
      .delete()
      .eq("sheet_name", sheetName)
      .select("id");

    if (deleteStudentsError) {
      console.error("[deleteExcelSheet] Error deleting students:", deleteStudentsError);
      throw deleteStudentsError;
    }

    // Clear supplementary_data from transactions linked to this sheet
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
        data.track_name === sheetName ||
        data.sheet_name === sheetName;

      if (!matches) continue;

      const { error: clearErr } = await supabase
        .from("transactions")
        .update({ supplementary_data: null, linked_at: null })
        .eq("id", tx.id);

      if (clearErr) throw clearErr;
      clearedTransactions++;
    }

    console.log(
      `[deleteExcelSheet] Deleted sheet "${sheetName}": students=${(deletedStudents || []).length}, unmatched=${(deletedRows || []).length}, clearedTx=${clearedTransactions}`
    );

    res.json({
      success: true,
      message: `Deleted Excel sheet "${sheetName}"`,
      deletedStudents: (deletedStudents || []).length,
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
  getStudents,
  getStudentsBySheet,
  getStudentById,
  listExcelSheets,
  deleteExcelSheet,
  deleteExcelImport,
  debugExcel,
};
