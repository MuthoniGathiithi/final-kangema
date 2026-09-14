/**
 * Quick Node tester for Excel parse + API calls.
 *
 * 1) Start server:  npm run dev
 * 2) Run:
 *      node scripts/test-excel.js ./your-fee-register.xlsx
 *
 * Env (optional):
 *   BASE_URL=http://localhost:5000
 *   API_KEY=...   # if APP_API_KEY is set
 */

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { findHeaderRowIndex, rowToObject } = require("../utils/excelParse");

const BASE_URL = process.env.BASE_URL || "http://localhost:5000";
const API_KEY = process.env.API_KEY || "";
const filePath = process.argv[2];

function headers() {
  const h = {};
  if (API_KEY) h["x-api-key"] = API_KEY;
  return h;
}

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: headers(),
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  console.log(`\n${method} ${urlPath} -> ${res.status}`);
  console.log(JSON.stringify(json, null, 2));
  return { status: res.status, json };
}

function localParsePreview(file) {
  const buf = fs.readFileSync(file);
  const workbook = XLSX.read(buf, { type: "buffer" });
  console.log("\n== Local parse preview ==");
  console.log("Sheets:", workbook.SheetNames);

  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      defval: null,
      blankrows: false,
    });
    const headerIdx = findHeaderRowIndex(rows);
    console.log(`\n[${sheetName}] headerRowIndex=${headerIdx}`);
    if (headerIdx === -1) {
      console.log("  SKIP: no ADM + NAME header found");
      continue;
    }
    const sample = rows.slice(headerIdx + 1, headerIdx + 4);
    for (const r of sample) {
      const p = rowToObject(rows[headerIdx], r, sheetName);
      console.log("  sample:", {
        accountNumber: p.accountNumber,
        studentName: p.studentName,
        amount: p.amount,
        trackName: p.trackName,
      });
    }
  }
}

async function main() {
  if (!filePath) {
    console.error("Usage: node scripts/test-excel.js path/to/file.xlsx");
    process.exit(1);
  }
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) {
    console.error("File not found:", abs);
    process.exit(1);
  }

  localParsePreview(abs);

  // Health (no auth usually)
  await api("GET", "/api/health");

  // Debug via API
  const form = new FormData();
  const blob = new Blob([fs.readFileSync(abs)]);
  form.append("file", blob, path.basename(abs));

  const debugForm = new FormData();
  debugForm.append("file", new Blob([fs.readFileSync(abs)]), path.basename(abs));
  {
    const res = await fetch(`${BASE_URL}/api/excel/debug`, {
      method: "POST",
      headers: headers(),
      body: debugForm,
    });
    console.log(`\nPOST /api/excel/debug -> ${res.status}`);
    console.log(JSON.stringify(await res.json(), null, 2));
  }

  // Import
  const importForm = new FormData();
  importForm.append("file", new Blob([fs.readFileSync(abs)]), path.basename(abs));
  let importId = null;
  {
    const res = await fetch(`${BASE_URL}/api/excel/import`, {
      method: "POST",
      headers: headers(),
      body: importForm,
    });
    const json = await res.json();
    console.log(`\nPOST /api/excel/import -> ${res.status}`);
    console.log(JSON.stringify(json, null, 2));
    importId = json.importId || null;
  }

  await api("GET", "/api/excel/sheets");
  await api("GET", "/api/excel/imports");
  await api("GET", "/api/excel/data");
  await api("GET", "/api/students/sheets");

  console.log("\n-- Delete examples (not run automatically) --");
  console.log(`DELETE ${BASE_URL}/api/excel/sheets/${encodeURIComponent("GRADE 10 - KENYATTA")}`);
  console.log(`DELETE ${BASE_URL}/api/students/sheets/${encodeURIComponent("GRADE 10 - KENYATTA")}`);
  if (importId) {
    console.log(`DELETE ${BASE_URL}/api/excel/import/${importId}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
