export interface Platform {
  id: string
  name: string
  billingMode: 'fixed' | 'split'
  price: number
  totalCost: number
  archived?: boolean
  archivedAt?: string
  archivedMonth?: string
}

export interface Member {
  id: string
  name: string
  priorBalance: number
  customFee: number | null
  status?: string
  archivedAt?: string
  archivedMonth?: string
}

export interface Subscription {
  id: string
  memberId: string
  platformId: string
  memberName: string
  platformName: string
  startMonth: string
  exitMonth?: string
  seatLabel?: string
  allowDuplicate?: boolean
}

export interface Payment {
  id: string
  memberId: string
  memberName: string
  date: string
  amount: number
  method: string
  cycle: string
  note?: string
  createdAt?: string
  recordedAt?: string
  status?: string
  voidedAt?: string
  voidedBy?: string
  voidReason?: string
}

export interface TempCharge {
  id: string
  memberId: string
  memberName: string
  date?: string
  amount: number
  desc?: string
  description?: string
  cycle?: string
  createdAt?: string
  recordedAt?: string
  status?: string
  voidedAt?: string
  voidedBy?: string
  voidReason?: string
}

export interface BalanceEntry {
  id: string
  memberId?: string
  memberName: string
  priorBalance: number
  subscriptionFee: number
  tempCharge: number
  paid: number
  endingBalance: number
}

export interface HistorySeal {
  version: number
  previousHash: string | null
  hash: string
  sealedAt: string
  reason: string
}

export interface HistoryEntry {
  month: string
  balances: BalanceEntry[]
  payments: Payment[]
  tempCharges: TempCharge[]
  seal: HistorySeal
}

export interface LedgerEvent {
  id: string
  at: string
  actor: string
  type: string
  summary: string
  month: string
  entityType: string
  entityId: string | null
  amount: number | null
  payload: Record<string, unknown> | null
  previousHash: string | null
  hash: string
}

export interface Ledger {
  version: number
  entries: LedgerEvent[]
  lastHash: string
  updatedAt: string
}

export interface Database {
  currentMonth: string
  baseMonth: string
  bankInfo: string
  platforms: Platform[]
  members: Member[]
  subscriptions: Subscription[]
  payments: Payment[]
  tempCharges: TempCharge[]
  history: HistoryEntry[]
  reminderStyle: string
  ledger: Ledger
  [key: string]: unknown
}

export interface AuditWarning {
  id: string
  type: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  title: string
  detail: string
  code: string
  memberId?: string
  platformId?: string
}

export interface ClosePreview {
  currentMonth: string
  nextMonth: string
  ready: boolean
  totals: {
    subscriptionFee: number
    paid: number
    receivable: number
    unpaidMembers: number
  }
  checks: Array<{
    id: string
    status: 'pass' | 'warn' | 'fail'
    label: string
    detail: string
  }>
  blockers: Array<{
    code: string
    title: string
    detail: string
  }>
  warnings: Array<{
    code: string
    title: string
    detail: string
  }>
}

export interface SystemSnapshot {
  version: string
  generatedAt: string
  currentMonth: string
  baseMonth: string
  members: number
  platforms: number
  subscriptions: number
  activeSubscriptions: number
  totalPayments: number
  totalTempCharges: number
  totalReceivable: number
  paidThisMonth: number
  unpaidMembers: number
  historyMonths: number
  health: {
    status: 'clean' | 'warning' | 'risk'
    warningsCount: number
    sealedHistoryCount: number
    ledgerIntegrity: boolean
  }
}

export interface MemberSummary {
  member: Member
  subscriptions: Subscription[]
  monthlyFee: number
  tempChargesTotal: number
  paidTotal: number
  priorBalance: number
  outstanding: number
}

export interface BackupInfo {
  filename: string
  label: string
  createdAt: string
  size: number
  month: string
  hash: string
}

export interface BackupPreview {
  filename: string
  original: {
    currentMonth: string
    totalMembers: number
    totalPayments: number
    totalCharges: number
    totalReceivable: number
  }
  restored: {
    currentMonth: string
    totalMembers: number
    totalPayments: number
    totalCharges: number
    totalReceivable: number
  }
  changes: string[]
}

export interface AIMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  tool_calls?: AIToolCall[]
}

export interface AIToolCall {
  id?: string
  type: string
  function: {
    name: string
    arguments: string
  }
}

export interface AISessionMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  tool_calls?: Array<{
    id: string
    type: string
    function: {
      name: string
      arguments: string
    }
  }>
}

export interface LedgerSummary {
  integrity: 'valid' | 'invalid' | 'empty'
  count: number
  lastHash: string
  updatedAt: string
  recentEvents: LedgerEvent[]
  details?: string[]
}

export interface HistoryIntegrity {
  valid: boolean
  sealedCount: number
  totalCount: number
  chainBroken: boolean
  details: string[]
}

export interface GoogleOAuthConfig {
  clientId: string
  clientSecret: string
  allowedEmails: Set<string>
  authUrl: string
  tokenUrl: string
  userinfoUrl: string
  redirectUri: string
}

export interface SessionCookiePayload {
  v: number
  iat: number
  exp: number
  user: { email: string; name?: string } | null
}

export interface SessionVerificationResult {
  ok: boolean
  reason?: string
  session?: SessionCookiePayload
}

export type ReminderStyle = 'friendly' | 'professional' | 'pirate' | 'poetic' | 'urgent' | 'minimal'
