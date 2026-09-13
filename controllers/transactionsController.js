const supabase = require("../config/supabase");
const { toEAT } = require("../utils/time");

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
  };
}

/**
 * GET /api/transactions
 * Query params: page, pageSize, search (matches code/account/msisdn), source, from, to
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
      query = query.or(
        `transaction_code.ilike.%${search}%,account_number.ilike.%${search}%,msisdn.ilike.%${search}%`
      );
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
      firstName,
      middleName,
      lastName,
      time,
      businessShortcode,
      source,
      rawPayload,
    } = req.body;

    if (!amount || !accountNumber) {
      return res
        .status(400)
        .json({ success: false, message: "amount and accountNumber are required" });
    }

    const { data, error } = await supabase
      .from("transactions")
      .insert({
        transaction_code: code || null,
        account_number: accountNumber,
        amount,
        msisdn: msisdn || null,
        first_name: firstName || null,
        middle_name: middleName || null,
        last_name: lastName || null,
        transaction_time: time ? new Date(time).toISOString() : new Date().toISOString(),
        business_shortcode: businessShortcode || null,
        source: source === "sms" ? "sms" : "manual",
        raw_payload: rawPayload || null,
      })
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ success: true, transaction: formatTransaction(data) });
  } catch (err) {
    next(err);
  }
}

module.exports = { listTransactions, getTransaction, createManualTransaction, formatTransaction };
