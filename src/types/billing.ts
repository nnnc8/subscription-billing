export interface Platform {
  id: string
  name: string
  billingMode: 'fixed' | 'split'
  price: number
  totalCost: number
  status?: string
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
  id?: string
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
  seal?: HistorySeal
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

export interface LifecycleMetadata {
  timezone: string                  // e.g. 'Asia/Taipei'
  autoAdvanceEnabled: boolean
  lastCheckedAt: string | null      // ISO 8601
  lastAdvancedAt: string | null     // ISO 8601
  lastAdvancedFrom: string | null   // YYYY/MM
  lastAdvancedTo: string | null     // YYYY/MM
}

export interface LifecycleStatus {
  currentMonth: string              // db.currentMonth
  systemMonth: string               // Taipei real month
  isCurrent: boolean                // currentMonth === systemMonth
  timezone: string
  lastAdvancedAt: string | null
  lastAdvancedFrom: string | null
  lastAdvancedTo: string | null
  blockedReason: string | null
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
  lifecycle?: LifecycleMetadata
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
    priorBalance: number
    subscriptionFee: number
    tempCharge: number
    paid: number
    endingBalance: number
    receivable: number
    unpaidMembers: number
  }
  balances: BalanceEntry[]
  checks: Array<{
    id: string
    status: 'pass' | 'warn' | 'fail' | 'block'
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
  ok: boolean
  fingerprint: string
  currentMonth: string
  generatedAt: string
  health: {
    status: 'clean' | 'warning' | 'risk'
    label: string
    warningCount: number
    criticalCount: number
    ledgerOk: boolean
  }
  counts: {
    members: number
    activeMembers: number
    archivedMembers: number
    platforms: number
    activePlatforms: number
    archivedPlatforms: number
    subscriptions: number
    payments: number
    paymentRecords: number
    voidedPayments: number
    tempCharges: number
    tempChargeRecords: number
    voidedTempCharges: number
    history: number
    ledger: number
  }
  totals: {
    subscriptionFee: number
    paid: number
    receivable: number
    unpaidMembers: number
  }
  history: {
    count: number
    latestMonth: string | null
    integrity: any
  }
  ledger: {
    ok: boolean
    count: number
    lastHash: string | null
    latest: any
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

// ---------------------------------------------------------------------------
// Automation Inbox (GenAI Demo)
// ---------------------------------------------------------------------------

export type ProposalKind = 'payment' | 'subscription' | 'tempCharge'
export type ProposalStatus = 'applied' | 'pending' | 'rejected'

export interface AutomationProposal {
  id: string
  kind: ProposalKind
  sourceText: string
  confidence: number          // 0–1, as parsed by Gemini
  reason: string              // AI 解析理由
  warnings: string[]          // 潛在風險說明 (deterministic layer)
  payload: Record<string, unknown>  // 對應既有 API 欄位
  status: ProposalStatus
  createdAt: string
  appliedAt?: string
  rejectedAt?: string
  rejectedBy?: string
  rejectReason?: string
  ledgerEventId?: string      // 套用後對應的 ledger event id
}

export interface AutomationIngestResult {
  applied: AutomationProposal[]
  pending: AutomationProposal[]
  rejected: AutomationProposal[]
  parseErrors: string[]
}
