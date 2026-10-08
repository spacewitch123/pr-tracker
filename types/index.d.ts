export type PrChecks = { passed: number; failed: number; pending: number; total: number; isRequiredOnly: boolean }

export type PrReadiness = 'ready' | 'blocked' | 'conflicts' | 'behind' | 'unstable' | 'draft' | 'checking'

export type TrackedPr = {
  key: string
  number: number
  title: string
  url: string
  repo: string
  branch: string
  isDraft: boolean
  approvals: number
  changesRequested: number
  pendingReviewers: number
  decision: string | null
  checks: PrChecks
  hasConflicts: boolean
  readiness: PrReadiness
  blockedBecause: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'pr-tracker': {
      prs: TrackedPr[]
      totalOpen: number
      branch: string | null
      syncedAt: number | null
      error: string | null
      isVisible: boolean
    }
  }
}
