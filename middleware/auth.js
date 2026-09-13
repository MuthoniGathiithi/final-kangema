/**
 * Protects internal endpoints (listing transactions, excel import, stk push trigger)
 * with a simple shared-secret API key, passed as header: x-api-key
 *
 * This does NOT apply to Daraja's own callback endpoints (validation/confirmation/stk callback),
 * since Safaricom's servers call those directly and won't send your custom header.
 */
function requireApiKey(req, res, next) {
  const expected = process.env.APP_API_KEY;

  // If no key is configured, skip the check (useful for quick local testing)
  if (!expected) {
    return next();
  }

  const provided = req.headers["x-api-key"];
  if (provided && provided === expected) {
    return next();
  }

  return res.status(401).json({ success: false, message: "Invalid or missing API key" });
}

module.exports = { requireApiKey };
