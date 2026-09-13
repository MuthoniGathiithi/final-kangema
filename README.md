# Backend-mpesa

A Node.js/Express backend that:

1. Receives real M-Pesa Paybill transactions from Safaricom's **Daraja API** (C2B validation/confirmation + STK push callback), and stores them in **Supabase**.
2. Lists transactions with full metadata: **code, account number, amount, time, phone number**.
3. Accepts an **Excel import** to attach supplementary data to existing transactions, linked by **account number**.
4. Also accepts transactions submitted manually (e.g. captured from device SMS by the mobile app) via `/api/transactions/manual`, so SMS-sourced and Daraja-sourced transactions live in one place.

Runs identically **locally** (`node server.js`) and **hosted on Vercel** (serverless, via `api/index.js`).

---

## 1. Project structure

```
Backend-mpesa/
├── api/index.js          # Vercel serverless entry (wraps app.js)
├── app.js                # The actual Express app (routes, middleware)
├── server.js             # Local dev entry point (node server.js)
├── vercel.json            # Vercel routing config
├── config/
│   ├── daraja.js          # Daraja OAuth, STK push, C2B URL registration
│   └── supabase.js        # Supabase client
├── controllers/
│   ├── mpesaController.js       # Handles Daraja callbacks
│   ├── transactionsController.js # List/get/create transactions
│   └── excelImportController.js  # Excel import + linking logic
├── routes/
│   ├── mpesa.js
│   ├── transactions.js
│   └── excelImport.js
├── middleware/
│   ├── auth.js             # x-api-key protection
│   └── errorHandler.js
├── utils/time.js           # EAT timezone handling
├── sql/schema.sql          # Run this in Supabase first
└── .env.example
```

---

## 2. Set up Supabase (the database)

1. Create a project at https://supabase.com (or use your existing one).
2. Open **SQL Editor** → **New query** → paste the contents of `sql/schema.sql` → **Run**.
   This creates the `transactions`, `excel_imports`, and `excel_unmatched_rows` tables.
3. Go to **Project Settings → API** and copy:
   - `Project URL` → `SUPABASE_URL`
   - `service_role` key (NOT the anon key — this backend needs write access) → `SUPABASE_SERVICE_ROLE_KEY`

---

## 3. Set up Daraja (Safaricom developer account)

1. Create an app at https://developer.safaricom.co.ke → **My Apps** → get your **Consumer Key** and **Consumer Secret**.
2. For **sandbox testing**, use the default test paybill `174379` and its Lipa Na M-Pesa passkey (shown on the Daraja "Lipa Na M-Pesa Online" test credentials page) — no need to wait for a real paybill.
3. For **production**, you'll register your real paybill's shortcode + passkey and go through Safaricom's go-live process.

---

## 4. Configure environment variables

```bash
cp .env.example .env
```

Fill in `.env` with your real values. Key ones to get right:

- `MPESA_ENV=sandbox` while testing, `production` when live.
- `BASE_URL` — **must be a public HTTPS URL**. Locally this means using a tunnel (see below); once hosted, this is your Vercel URL.
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — from step 2.
- `APP_API_KEY` — any random string. Protects your own endpoints (`/api/transactions`, `/api/excel/import`, `/api/mpesa/stk/push`). Send it as header `x-api-key` from your React Native app. Leave blank to disable auth during early local testing (not recommended once hosted).

---

## 5. Install & run locally

```bash
npm install
npm run dev      # uses nodemon, auto-restarts on changes
# or
npm start        # plain node
```

You should see:
```
Backend-mpesa listening on http://localhost:5000
```

Test the health check:
```bash
curl http://localhost:5000/api/health
```

### Exposing your local server to Safaricom (for real callback testing)

Daraja callbacks only work with a public HTTPS URL — Safaricom's servers can't reach `localhost`. Use ngrok:

```bash
ngrok http 5000
```

Copy the `https://xxxx.ngrok-free.app` URL into `.env` as `BASE_URL`, restart the server, then register it with Daraja:

```bash
curl -X POST http://localhost:5000/api/mpesa/register-urls \
  -H "x-api-key: YOUR_APP_API_KEY"
```

Now trigger a test STK push to your own phone (sandbox uses Safaricom's test numbers, e.g. `254708374149`):

```bash
curl -X POST http://localhost:5000/api/mpesa/stk/push \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_APP_API_KEY" \
  -d '{"phone":"254708374149","amount":1,"accountReference":"TEST001","description":"Test payment"}'
```

Check it landed in the database:
```bash
curl http://localhost:5000/api/transactions -H "x-api-key: YOUR_APP_API_KEY"
```

---

## 6. Deploy to Vercel

```bash
npm install -g vercel   # if you don't have it
vercel login
vercel                  # first deploy (follow prompts)
```

In the Vercel dashboard → your project → **Settings → Environment Variables**, add every variable from `.env` (same names). Then set `BASE_URL` to the Vercel deployment URL (e.g. `https://backend-mpesa.vercel.app`) and redeploy:

```bash
vercel --prod
```

Register the (now permanent) callback URLs with Daraja once:

```bash
curl -X POST https://backend-mpesa.vercel.app/api/mpesa/register-urls \
  -H "x-api-key: YOUR_APP_API_KEY"
```

From here on, Safaricom calls your Vercel URL directly — no ngrok needed. Because `BASE_URL` is now stable, you generally only re-run `register-urls` if the domain ever changes.

---

## 7. API reference

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| GET | `/api/health` | — | Health check |
| GET | `/api/transactions?page=1&pageSize=25&search=&source=&from=&to=` | `x-api-key` | List transactions, filterable/searchable, paginated |
| GET | `/api/transactions/:id` | `x-api-key` | Get one transaction |
| POST | `/api/transactions/manual` | `x-api-key` | Insert a transaction captured elsewhere (e.g. from SMS) |
| POST | `/api/mpesa/c2b/validation` | — (Safaricom calls this) | Daraja validation hook |
| POST | `/api/mpesa/c2b/confirmation` | — (Safaricom calls this) | Daraja confirmation hook — where real paybill payments land |
| POST | `/api/mpesa/stk/callback` | — (Safaricom calls this) | STK push result hook |
| POST | `/api/mpesa/stk/push` | `x-api-key` | Trigger an STK push prompt |
| POST | `/api/mpesa/register-urls` | `x-api-key` | (Re)register callback URLs with Daraja |
| POST | `/api/excel/import` | `x-api-key` | Upload an Excel file (`multipart/form-data`, field `file`) to attach supplementary data, matched by account number |

All transaction objects returned look like:

```json
{
  "id": "uuid",
  "code": "SFG7HJ9K2L",
  "accountNumber": "0722000000",
  "amount": 500,
  "msisdn": "254712345678",
  "payerName": "JOHN M DOE",
  "time": "2026-09-13 17:24:00",
  "businessShortcode": "174379",
  "source": "daraja",
  "supplementaryData": null,
  "createdAt": "2026-09-13 17:24:05"
}
```

`time` and `createdAt` are always formatted in **East Africa Time**, regardless of server/database internal timezone.

---

## 8. Notes for the React Native app (next step)

- Point the app at `BASE_URL` from step 6, sending `x-api-key` on every request to `/api/transactions*`, `/api/excel/import`, `/api/mpesa/stk/push`.
- For SMS-captured transactions, POST the parsed SMS to `/api/transactions/manual` with `source: "sms"` so both sources land in the same table and the same list.
- Excel import: build a simple file picker + upload screen hitting `/api/excel/import`; the response tells you how many rows matched vs. didn't.
