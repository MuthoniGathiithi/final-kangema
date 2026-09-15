const supabase = require("../config/supabase");
const { toEAT } = require("../utils/time");
const XLSX = require("xlsx");

function formatTransaction(row) {
  return {
    id: row.id,
    code: row.transaction_code,
    accountNumber: row.account_number,
    amount: Number(row.amount),
    msisdn: row.msisdn,
    payerName: [row.first_name, row.middle_name, row.last_name]
      .filter(Boolean)
      .join(" "),
    time: toEAT(row.transaction_time),
    businessShortcode: row.business_shortcode,
    source: row.source,
    supplementaryData: row.supplementary_data || null,
    createdAt: toEAT(row.created_at),
    rawMessage: row.raw_message || null,
  };
}

/**
 * GET /api/transactions
 * Query params: page, pageSize, search (matches code/account/msisdn/name/amount), source, from, to
 */
async function listTransactions(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const pageSize = Math.min(parseInt(req.query.pageSize) || 25, 200);
    const { search, source, from, to } = req.query;

    let query = supabase
      .from("transactions")
      .select("*", { count: "exact" })
      .order("transaction_time", { ascending: false });

    if (search) {
      const isNumeric = /^\d+(\.\d+)?$/.test(search.trim());
      const clauses = [
        `transaction_code.ilike.%${search}%`,
        `account_number.ilike.%${search}%`,
        `msisdn.ilike.%${search}%`,
        `first_name.ilike.%${search}%`,
        `last_name.ilike.%${search}%`,
      ];
      if (isNumeric) {
        clauses.push(`amount.eq.${search.trim()}`);
      }
      query = query.or(clauses.join(","));
    }
    if (source) {
      query = query.eq("source", source);
    }
    if (from) {
      query = query.gte("transaction_time", from);
    }
    if (to) {
      query = query.lte("transaction_time", to);
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
      transactions: data.map(formatTransaction),
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/transactions/:id
 */
async function getTransaction(req, res, next) {
  try {
    const { id } = req.params;
    const { data, error } = await supabase
      .from("transactions")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, message: "Transaction not found" });
    }

    res.json({ success: true, transaction: formatTransaction(data) });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/transactions/manual
 * Lets you add a transaction manually (e.g. one captured from SMS on the mobile app,
 * forwarded here so it lands in the same shared database as Daraja transactions).
 */
async function createManualTransaction(req, res, next) {
  try {
    const {
      code,
      accountNumber,
      amount,
      msisdn,
      payerName,
      firstName,
      middleName,
      lastName,
      time,
      businessShortcode,
      source,
      rawPayload,
      rawMessage,
    } = req.body;

    if (!amount || !accountNumber) {
      return res
        .status(400)
        .json({ success: false, message: "amount and accountNumber are required" });
    }

    const isSms = source === "sms";

    // Handle payerName: if provided, split it into first/middle/last names
    let finalFirstName = firstName;
    let finalMiddleName = middleName;
    let finalLastName = lastName;

    if (payerName && !firstName) {
      const nameParts = payerName.trim().split(/\s+/);
      finalFirstName = nameParts[0] || null;
      finalMiddleName = nameParts.length > 2 ? nameParts.slice(1, -1).join(" ") : null;
      finalLastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : null;
    }

    const { data, error } = await supabase
      .from("transactions")
      .upsert({
        transaction_code: code || null,
        account_number: accountNumber,
        amount,
        msisdn: msisdn || null,
        first_name: finalFirstName || null,
        middle_name: finalMiddleName || null,
        last_name: finalLastName || null,
        transaction_time: time ? new Date(time).toISOString() : new Date().toISOString(),
        business_shortcode: businessShortcode || null,
        source: isSms ? "sms" : "manual",
        raw_payload: rawPayload || null,
        raw_message: rawMessage || null,
      }, {
        onConflict: "transaction_code",
        ignoreDuplicates: false
      })
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({ success: true, transaction: formatTransaction(data) });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/stats/total-amount
 * Returns total amount of all unique transactions
 */
async function getTotalAmount(req, res, next) {
  try {
    // Get all transactions
    const { data: allTx, error: allError } = await supabase
      .from("transactions")
      .select("amount, transaction_code");

    if (allError) throw allError;

    // Deduplicate by transaction_code
    const uniqueTransactions = new Map();
    for (const tx of allTx || []) {
      const key = tx.transaction_code || `tx-${tx.amount}`;
      if (!uniqueTransactions.has(key)) {
        uniqueTransactions.set(key, tx);
      }
    }

    const uniqueArray = Array.from(uniqueTransactions.values());
    const totalAmount = uniqueArray.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);

    res.json({
      success: true,
      total_amount: totalAmount,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/transactions/stats
 * Returns dashboard statistics: counts by source and total amount
 */
async function getTransactionStats(req, res, next) {
  try {
    // Get all transactions with needed fields
    const { data: allTx, error: allError } = await supabase
      .from("transactions")
      .select("source, amount, transaction_code, account_number");

    if (allError) {
      console.error("[getTransactionStats] Error fetching transactions:", allError);
      throw allError;
    }

    console.log("[getTransactionStats] Total transactions fetched:", allTx?.length || 0);
    
    // Log sample source values for debugging
    if (allTx && allTx.length > 0) {
      const sampleSources = [...new Set(allTx.slice(0, 10).map(tx => tx.source))];
      console.log("[getTransactionStats] Sample source values:", sampleSources);
    }

    // Deduplicate by transaction_code and calculate totals
    const uniqueTransactions = new Map();
    for (const tx of allTx || []) {
      const key = tx.transaction_code || `${tx.source}-${tx.amount}-${tx.account_number}`;
      if (!uniqueTransactions.has(key)) {
        uniqueTransactions.set(key, tx);
      }
    }

    const uniqueArray = Array.from(uniqueTransactions.values());
    console.log("[getTransactionStats] Unique transactions after dedup:", uniqueArray.length);
    
    const totalCount = uniqueArray.length;
    
    // Case-insensitive matching for source field
    const smsCount = uniqueArray.filter(tx => tx.source && tx.source.toLowerCase() === "sms").length;
    const darajaCount = uniqueArray.filter(tx => tx.source && tx.source.toLowerCase() === "daraja").length;
    const manualCount = uniqueArray.filter(tx => tx.source && tx.source.toLowerCase() === "manual").length;
    
    const totalAmount = uniqueArray.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);

    console.log("[getTransactionStats] Stats:", { totalCount, smsCount, darajaCount, manualCount, totalAmount });

    res.json({
      success: true,
      stats: {
        totalTransactions: totalCount,
        smsTransactions: smsCount,
        darajaTransactions: darajaCount,
        manualTransactions: manualCount,
        totalAmount: totalAmount,
      },
    });
  } catch (err) {
    console.error("[getTransactionStats] Error:", err);
    next(err);
  }
}

/**
 * GET /api/transactions/export
 * Exports all transactions as an Excel (.xlsx) file
 */
async function exportTransactions(req, res, next) {
  try {
    const { search, source, from, to } = req.query;

    let query = supabase
      .from("transactions")
      .select("*")
      .order("transaction_time", { ascending: false });

    if (search) {
      const isNumeric = /^\d+(\.\d+)?$/.test(search.trim());
      const clauses = [
        `transaction_code.ilike.%${search}%`,
        `account_number.ilike.%${search}%`,
        `msisdn.ilike.%${search}%`,
        `first_name.ilike.%${search}%`,
        `last_name.ilike.%${search}%`,
      ];
      if (isNumeric) {
        clauses.push(`amount.eq.${search.trim()}`);
      }
      query = query.or(clauses.join(","));
    }
    if (source) {
      query = query.eq("source", source);
    }
    if (from) {
      query = query.gte("transaction_time", from);
    }
    if (to) {
      query = query.lte("transaction_time", to);
    }

    const { data, error } = await query;
    if (error) throw error;

    const worksheetData = [
      ["Code", "Account Number", "MSISDN", "Payer Name", "Amount", "Time", "Business Shortcode", "Source"],
      ...data.map((row) => [
        row.transaction_code || "",
        row.account_number || "",
        row.msisdn || "",
        [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(" "),
        Number(row.amount) || 0,
        toEAT(row.transaction_time),
        row.business_shortcode || "",
        row.source || "",
      ]),
    ];

    const worksheet = XLSX.utils.aoa_to_sheet(worksheetData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Transactions");

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=transactions.xlsx");
    res.send(buffer);
  } catch (err) {
    next(err);
  }
}

module.exports = { listTransactions, getTransaction, createManualTransaction, exportTransactions, getTransactionStats, getTotalAmount, formatTransaction };