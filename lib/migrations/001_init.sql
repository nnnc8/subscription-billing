CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS platforms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  billingMode TEXT NOT NULL,
  price INTEGER NOT NULL,
  totalCost INTEGER NOT NULL,
  status TEXT,
  archived INTEGER DEFAULT 0,
  archivedAt TEXT,
  archivedMonth TEXT
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  priorBalance INTEGER NOT NULL,
  customFee INTEGER,
  status TEXT,
  archivedAt TEXT,
  archivedMonth TEXT
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  memberId TEXT,
  platformId TEXT,
  memberName TEXT NOT NULL,
  platformName TEXT NOT NULL,
  startMonth TEXT NOT NULL,
  exitMonth TEXT,
  seatLabel TEXT,
  allowDuplicate INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  memberId TEXT NOT NULL,
  memberName TEXT NOT NULL,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  cycle TEXT NOT NULL,
  note TEXT,
  createdAt TEXT,
  recordedAt TEXT,
  status TEXT,
  voidedAt TEXT,
  voidedBy TEXT,
  voidReason TEXT
);

CREATE TABLE IF NOT EXISTS temp_charges (
  id TEXT PRIMARY KEY,
  memberId TEXT NOT NULL,
  memberName TEXT NOT NULL,
  date TEXT,
  amount INTEGER NOT NULL,
  desc TEXT,
  description TEXT,
  cycle TEXT,
  createdAt TEXT,
  recordedAt TEXT,
  status TEXT,
  voidedAt TEXT,
  voidedBy TEXT,
  voidReason TEXT
);

CREATE TABLE IF NOT EXISTS history (
  month TEXT PRIMARY KEY,
  balances_json TEXT NOT NULL,
  payments_json TEXT NOT NULL,
  temp_charges_json TEXT NOT NULL,
  seal_json TEXT
);

CREATE TABLE IF NOT EXISTS ledger_events (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  month TEXT NOT NULL,
  entityType TEXT NOT NULL,
  entityId TEXT,
  amount INTEGER,
  payload_json TEXT,
  hash TEXT,
  previousHash TEXT
);
