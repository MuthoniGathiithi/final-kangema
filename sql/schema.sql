-- ==========================================================
-- Backend-mpesa Supabase Schema
-- Run this in the Supabase SQL editor (Project -> SQL Editor -> New query)
-- ==========================================================

-- Core table: every M-Pesa transaction, whichever source it came from
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),

  -- Core M-Pesa metadata
  transaction_code text unique,        -- e.g. "SFG7HJ9K2L" (the M-Pesa receipt number)
  account_number text,                 -- the account/reference number entered by payer
  amount numeric(12,2) not null default 0,
  msisdn text,                         -- payer phone number, e.g. 2547XXXXXXXX
  first_name text,
  middle_name text,
  last_name text,
  transaction_time timestamptz,        -- actual M-Pesa transaction time (stored in UTC, display in EAT)
  business_shortcode text,             -- the paybill number

  -- Where this record came from
  source text not null default 'daraja' check (source in ('daraja', 'sms', 'manual')),
  raw_payload jsonb,                   -- full original payload (Daraja callback or parsed SMS) for auditing
  raw_message text,                    -- raw SMS message body (for SMS source only)

  -- Excel-imported supplementary fields (linked via account_number)
  supplementary_data jsonb,            -- flexible bag for whatever the Excel file provides
  linked_at timestamptz,               -- when supplementary data was last linked/merged in

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_transactions_account_number on transactions (account_number);
create index if not exists idx_transactions_transaction_time on transactions (transaction_time desc);
create index if not exists idx_transactions_source on transactions (source);

-- Keep updated_at fresh on every update
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_transactions_updated_at on transactions;
create trigger trg_transactions_updated_at
before update on transactions
for each row execute function set_updated_at();

-- Log of Excel import batches (for traceability - who imported what, when)
create table if not exists excel_imports (
  id uuid primary key default gen_random_uuid(),
  file_name text,
  rows_total int default 0,
  rows_matched int default 0,
  rows_unmatched int default 0,
  imported_at timestamptz not null default now(),
  details jsonb
);

-- Rows from an Excel import that didn't match any existing transaction by account_number,
-- kept so they can be reviewed/re-linked later instead of being silently dropped.
create table if not exists excel_unmatched_rows (
  id uuid primary key default gen_random_uuid(),
  import_id uuid references excel_imports(id) on delete cascade,
  account_number text,
  row_data jsonb,
  created_at timestamptz not null default now()
);
