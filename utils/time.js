const dayjs = require("dayjs");
const utc = require("dayjs/plugin/utc");
const timezone = require("dayjs/plugin/timezone");

dayjs.extend(utc);
dayjs.extend(timezone);

const EAT = "Africa/Nairobi";

/**
 * Parses a Daraja TransTime string ("20250913173045") into a proper Date (UTC),
 * treating the input as already being in EAT (Daraja timestamps are EAT).
 */
function parseDarajaTimestamp(transTime) {
  if (!transTime) return null;
  const s = String(transTime);
  const formatted = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(
    8,
    10
  )}:${s.slice(10, 12)}:${s.slice(12, 14)}`;
  return dayjs.tz(formatted, EAT).utc().toDate();
}

/**
 * Formats any timestamp (Date, ISO string, etc.) for API responses,
 * always displayed in East Africa Time regardless of server timezone.
 */
function toEAT(timestamp) {
  if (!timestamp) return null;
  return dayjs(timestamp).tz(EAT).format("YYYY-MM-DD HH:mm:ss");
}

module.exports = { parseDarajaTimestamp, toEAT, EAT };
