const supabase = require("../config/supabase");
const { parseDarajaTimestamp } = require("../utils/time");
const daraja = require("../config/daraja");

function c2bValidation(req, res) {
  console.log("[c2b:validation]", JSON.stringify(req.body));
  return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
}

async function c2bConfirmation(req, res) {
  console.log("[c2b:confirmation]", JSON.stringify(req.body));

  try {
    const body = req.body || {};

    const record = {
      transaction_code: body.TransID || null,
      account_number: body.BillRefNumber || null,
      amount: Number(body.TransAmount) || 0,
      msisdn: body.MSISDN || null,
      first_name: body.FirstName || null,
      middle_name: body.MiddleName || null,
      last_name: body.LastName || null,
      transaction_time: parseDarajaTimestamp(body.TransTime),
      business_shortcode: body.BusinessShortCode || null,
      source: "daraja",
      raw_payload: body,
    };

    const { error } = await supabase
      .from("transactions")
      .upsert(record, { onConflict: "transaction_code" });

    if (error) console.error("[c2b:confirmation] DB error:", error);
  } catch (err) {
    console.error("[c2b:confirmation] handler error:", err);
  }

  return res.json({ ResultCode: 0, ResultDesc: "Confirmation received successfully" });
}

async function stkCallback(req, res) {
  console.log("[stk:callback]", JSON.stringify(req.body));

  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) {
      return res.json({ ResultCode: 0, ResultDesc: "Ignored - no stkCallback body" });
    }

    if (callback.ResultCode !== 0) {
      console.log(`[stk:callback] Payment not completed: ${callback.ResultDesc}`);
      return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
    }

    const items = callback.CallbackMetadata?.Item || [];
    const get = (name) => items.find((i) => i.Name === name)?.Value;

    const record = {
      transaction_code: get("MpesaReceiptNumber") || null,
      amount: Number(get("Amount")) || 0,
      msisdn: get("PhoneNumber") ? String(get("PhoneNumber")) : null,
      account_number: null,
      transaction_time: get("TransactionDate")
        ? parseDarajaTimestamp(get("TransactionDate"))
        : new Date(),
      source: "daraja",
      raw_payload: req.body,
    };

    const { error } = await supabase
      .from("transactions")
      .upsert(record, { onConflict: "transaction_code" });

    if (error) console.error("[stk:callback] DB error:", error);
  } catch (err) {
    console.error("[stk:callback] handler error:", err);
  }

  return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
}

async function triggerStkPush(req, res, next) {
  try {
    const { phone, amount, accountReference, description } = req.body;
    if (!phone || !amount) {
      return res.status(400).json({ success: false, message: "phone and amount are required" });
    }
    const result = await daraja.stkPush({ phone, amount, accountReference, description });
    res.json({ success: true, result });
  } catch (err) {
    next(err);
  }
}

async function registerUrls(req, res, next) {
  try {
    const result = await daraja.registerC2BUrls();
    res.json({ success: true, result });
  } catch (err) {
    next(err);
  }
}

async function simulateC2B(req, res, next) {
  try {
    const { amount, msisdn, billRefNumber } = req.body;
    if (!amount || !msisdn) {
      return res.status(400).json({ success: false, message: "amount and msisdn are required" });
    }
    const result = await daraja.simulateC2B({ amount, msisdn, billRefNumber });
    res.json({ success: true, result });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  c2bValidation,
  c2bConfirmation,
  stkCallback,
  triggerStkPush,
  registerUrls,
  simulateC2B,
};