const axios = require("axios");
const dayjs = require("dayjs");

const IS_PRODUCTION = (process.env.MPESA_ENV || "sandbox") === "production";
const BASE_URL = IS_PRODUCTION
  ? "https://api.safaricom.co.ke"
  : "https://sandbox.safaricom.co.ke";

let cachedToken = null;
let cachedTokenExpiry = 0; // epoch ms

/**
 * Gets an OAuth access token from Daraja, caching it until ~60s before expiry.
 */
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry) {
    return cachedToken;
  }

  const key = process.env.MPESA_CONSUMER_KEY;
  const secret = process.env.MPESA_CONSUMER_SECRET;

  if (!key || !secret) {
    throw new Error(
      "MPESA_CONSUMER_KEY / MPESA_CONSUMER_SECRET are not set in the environment."
    );
  }

  const credentials = Buffer.from(`${key}:${secret}`).toString("base64");

  const { data } = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${credentials}` } }
  );

  cachedToken = data.access_token;
  // expires_in is in seconds (usually 3599); refresh a bit early
  cachedTokenExpiry = now + (Number(data.expires_in) - 60) * 1000;

  return cachedToken;
}

/**
 * Builds the Lipa Na M-Pesa password + timestamp pair used by STK push.
 */
function buildStkPassword() {
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const timestamp = dayjs().format("YYYYMMDDHHmmss");
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString(
    "base64"
  );
  return { password, timestamp };
}

/**
 * Triggers an STK push (Lipa Na M-Pesa Online) prompt on the payer's phone.
 * phone must be in the format 2547XXXXXXXX
 */
async function stkPush({ phone, amount, accountReference, description }) {
  const token = await getAccessToken();
  const { password, timestamp } = buildStkPassword();
  const shortcode = process.env.MPESA_SHORTCODE;
  const callbackUrl = `${process.env.BASE_URL}${process.env.MPESA_STK_CALLBACK_URL}`;

  const payload = {
    BusinessShortCode: shortcode,
    Password: password,
    Timestamp: timestamp,
    TransactionType: "CustomerPayBillOnline",
    Amount: amount,
    PartyA: phone,
    PartyB: shortcode,
    PhoneNumber: phone,
    CallBackURL: callbackUrl,
    AccountReference: accountReference || "BackendMpesa",
    TransactionDesc: description || "Payment",
  };

  const { data } = await axios.post(
    `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return data;
}

/**
 * Registers the Validation + Confirmation callback URLs against the paybill (C2B).
 * Only needs to be run once per shortcode (Daraja remembers it), but it's exposed
 * as an endpoint here so you can (re)register whenever your public URL changes,
 * e.g. every time you restart ngrok locally.
 */
async function registerC2BUrls() {
  const token = await getAccessToken();
  const shortcode = process.env.MPESA_SHORTCODE;

  const payload = {
    ShortCode: shortcode,
    ResponseType: "Completed",
    ConfirmationURL: `${process.env.BASE_URL}${process.env.MPESA_CONFIRMATION_URL}`,
    ValidationURL: `${process.env.BASE_URL}${process.env.MPESA_VALIDATION_URL}`,
  };

  const { data } = await axios.post(
    `${BASE_URL}/mpesa/c2b/v1/registerurl`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return data;
}

module.exports = {
  BASE_URL,
  getAccessToken,
  stkPush,
  registerC2BUrls,
};
