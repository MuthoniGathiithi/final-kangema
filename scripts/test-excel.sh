#!/usr/bin/env bash
# ============================================================
# Excel API smoke tests
# Usage:
#   chmod +x scripts/test-excel.sh
#   ./scripts/test-excel.sh path/to/your-file.xlsx
#
# Optional env:
#   BASE_URL=http://localhost:5000
#   API_KEY=your-app-api-key   # required if APP_API_KEY is set in .env
# ============================================================

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:5000}"
API_KEY="${API_KEY:-}"
FILE="${1:-}"

AUTH_HEADER=()
if [[ -n "$API_KEY" ]]; then
  AUTH_HEADER=(-H "x-api-key: $API_KEY")
fi

echo "== Health =="
curl -sS "${AUTH_HEADER[@]}" "$BASE_URL/api/health" | jq . || curl -sS "${AUTH_HEADER[@]}" "$BASE_URL/api/health"
echo

if [[ -z "$FILE" ]]; then
  echo "No Excel file given."
  echo "Usage: $0 path/to/file.xlsx"
  echo
  echo "Still listing sheets/imports so you can test delete..."
else
  if [[ ! -f "$FILE" ]]; then
    echo "File not found: $FILE"
    exit 1
  fi

  echo "== Debug parse (no DB write) =="
  curl -sS "${AUTH_HEADER[@]}" \
    -F "file=@${FILE}" \
    "$BASE_URL/api/excel/debug" | jq .
  echo

  echo "== Import Excel (all sheets) =="
  IMPORT_JSON=$(curl -sS "${AUTH_HEADER[@]}" \
    -F "file=@${FILE}" \
    "$BASE_URL/api/excel/import")
  echo "$IMPORT_JSON" | jq .
  IMPORT_ID=$(echo "$IMPORT_JSON" | jq -r '.importId // empty')
  echo
fi

echo "== List Excel sheets =="
curl -sS "${AUTH_HEADER[@]}" "$BASE_URL/api/excel/sheets" | jq .
echo

echo "== List Excel imports =="
curl -sS "${AUTH_HEADER[@]}" "$BASE_URL/api/excel/imports" | jq .
echo

echo "== Get unmatched Excel data =="
curl -sS "${AUTH_HEADER[@]}" "$BASE_URL/api/excel/data" | jq .
echo

echo "== List student sheets =="
curl -sS "${AUTH_HEADER[@]}" "$BASE_URL/api/students/sheets" | jq .
echo

# ---- Optional deletes (commented — uncomment to run) ----
# SHEET_NAME="GRADE 10 - KENYATTA"
# ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('''$SHEET_NAME'''))")
#
# echo "== Delete Excel sheet =="
# curl -sS -X DELETE "${AUTH_HEADER[@]}" "$BASE_URL/api/excel/sheets/$ENCODED" | jq .
#
# echo "== Delete students sheet =="
# curl -sS -X DELETE "${AUTH_HEADER[@]}" "$BASE_URL/api/students/sheets/$ENCODED" | jq .
#
# if [[ -n "${IMPORT_ID:-}" ]]; then
#   echo "== Delete whole import batch $IMPORT_ID =="
#   curl -sS -X DELETE "${AUTH_HEADER[@]}" "$BASE_URL/api/excel/import/$IMPORT_ID" | jq .
# fi

echo "Done."
