// Reading GitHub's answers into one tracked pull request each, and telling
// what changed between two readings. Pure, so the tests can hold it exactly.

import type { PrChecks, PrReadiness, TrackedPr } from '../types'

export const MAX_PRS = 10

export type PrRole = 'author' | 'reviewer'

// The GitHub project a git remote points at, as `owner/name`.
export function repoFromRemote(url: string): string | null {
  const match = url.trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)

  return match ? `${match[1]}/${match[2]}` : null
}

const LISTED_FIELDS = 'nodes { ... on PullRequest { number title url isDraft headRefName repository { nameWithOwner } author { login } } }'

// Open, non-draft PRs in one project that you wrote or were asked to review.
export function listQuery(repo: string): string {
  const scope = `repo:${repo} is:pr is:open draft:false`

  return `query {
  viewer { login }
  mine: search(query: ${JSON.stringify(`${scope} author:@me`)}, type: ISSUE, first: ${MAX_PRS}) { ${LISTED_FIELDS} }
  review: search(query: ${JSON.stringify(`${scope} review-requested:@me`)}, type: ISSUE, first: ${MAX_PRS}) { ${LISTED_FIELDS} }
}`
}

export type ListedPr = {
  number: number
  title: string
  url: string
  isDraft: boolean
  headRefName: string
  repository: { nameWithOwner: string }
  author: { login: string } | null
  role: PrRole
}

type Found = Omit<ListedPr, 'role'>

export type ListAnswer = {
  data?: { viewer?: { login: string }; mine?: { nodes: Found[] }; review?: { nodes: Found[] } }
}

export function listedOf(answer: ListAnswer): { login: string; prs: ListedPr[] } | null {
  const login = answer.data?.viewer?.login

  if (login === undefined) {
    return null
  }

  const prs: ListedPr[] = []
  const add = (nodes: Found[] | undefined, role: PrRole) => {
    for (const pr of nodes ?? []) {
      if (pr.number !== undefined && !pr.isDraft && !prs.some(p => p.url === pr.url)) {
        prs.push({ ...pr, role })
      }
    }
  }

  add(answer.data?.review?.nodes, 'reviewer')
  add(answer.data?.mine?.nodes, 'author')

  return { login, prs }
}

// One aliased query for every listed PR, so a refresh costs two requests.
export function detailQuery(prs: readonly ListedPr[]): string {
  const parts = prs.map((pr, i) => {
    const [owner, name] = pr.repository.nameWithOwner.split('/')
    const n = pr.number

    return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    pullRequest(number: ${n}) {
      number mergeable mergeStateStatus reviewDecision
      latestOpinionatedReviews(first: 30) { nodes { state author { login } } }
      reviewRequests(first: 30) { totalCount }
      reviews(last: 20) { nodes { id state body url author { login } } }
      comments(last: 20) { nodes { id body url author { login } } }
      reviewThreads(last: 30) { nodes { comments(last: 5) { nodes { id body url author { login } } } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion isRequired(pullRequestNumber: ${n}) }
        ... on StatusContext { context state isRequired(pullRequestNumber: ${n}) }
      } } } } } }
    }
  }`
  })

  return `query {\n  ${parts.join('\n  ')}\n}`
}

type Author = { login: string } | null
type Note = { id: string; body: string; url: string; author: Author; state?: string }
type Context =
  | { __typename: 'CheckRun'; name: string; status: string; conclusion: string | null; isRequired: boolean }
  | { __typename: 'StatusContext'; context: string; state: string; isRequired: boolean }

export type PrDetail = {
  number: number
  mergeable: string
  mergeStateStatus: string
  reviewDecision: string | null
  latestOpinionatedReviews: { nodes: Array<{ state: string; author: Author }> }
  reviewRequests: { totalCount: number }
  reviews: { nodes: Note[] }
  comments: { nodes: Note[] }
  reviewThreads: { nodes: Array<{ comments: { nodes: Note[] } }> }
  commits: { nodes: Array<{ commit: { statusCheckRollup: { contexts: { nodes: Context[] } } | null } }> }
}

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'ERROR', 'STARTUP_FAILURE', 'STALE'])

function outcome(c: Context): 'passed' | 'failed' | 'pending' {
  if (c.__typename === 'CheckRun') {
    if (c.status !== 'COMPLETED' || c.conclusion === null) {
      return 'pending'
    }

    return PASSED.has(c.conclusion) ? 'passed' : FAILED.has(c.conclusion) ? 'failed' : 'pending'
  }

  return c.state === 'SUCCESS' ? 'passed' : c.state === 'FAILURE' || c.state === 'ERROR' ? 'failed' : 'pending'
}

export function countChecks(contexts: readonly Context[]): PrChecks {
  // A rerun lists a check again: the last run of each name is the one that counts.
  const latest = new Map<string, Context>()

  for (const c of contexts) {
    latest.set(c.__typename === 'CheckRun' ? c.name : c.context, c)
  }

  const all = [...latest.values()]
  const required = all.filter(c => c.isRequired)
  const counted = required.length > 0 ? required : all
  const outcomes = counted.map(outcome)

  return {
    passed: outcomes.filter(o => o === 'passed').length,
    failed: outcomes.filter(o => o === 'failed').length,
    pending: outcomes.filter(o => o === 'pending').length,
    total: counted.length,
    isRequiredOnly: required.length > 0,
  }
}

export function readinessOf(
  pr: { isDraft: boolean },
  detail: Pick<PrDetail, 'mergeable' | 'mergeStateStatus' | 'reviewDecision'>,
  checks: PrChecks,
): { readiness: PrReadiness; blockedBecause: string | null } {
  if (pr.isDraft) {
    return { readiness: 'draft', blockedBecause: null }
  }

  if (detail.mergeable === 'CONFLICTING' || detail.mergeStateStatus === 'DIRTY') {
    return { readiness: 'conflicts', blockedBecause: null }
  }

  switch (detail.mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return { readiness: 'ready', blockedBecause: null }
    case 'UNSTABLE':
      return { readiness: 'unstable', blockedBecause: null }
    case 'BEHIND':
      return { readiness: 'behind', blockedBecause: null }
    case 'BLOCKED': {
      const because =
        detail.reviewDecision === 'CHANGES_REQUESTED'
          ? 'changes requested'
          : checks.failed > 0
            ? 'checks failing'
            : checks.pending > 0
              ? 'checks running'
              : detail.reviewDecision === 'REVIEW_REQUIRED'
                ? 'needs approval'
                : null
      return { readiness: 'blocked', blockedBecause: because }
    }
    default:
      return { readiness: 'checking', blockedBecause: null }
  }
}

export function toTracked(pr: ListedPr, detail: PrDetail): TrackedPr {
  const opinions = detail.latestOpinionatedReviews.nodes
  const contexts = detail.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []
  const checks = countChecks(contexts)
  const { readiness, blockedBecause } = readinessOf(pr, detail, checks)

  return {
    key: `${pr.repository.nameWithOwner}#${pr.number}`,
    role: pr.role,
    author: pr.author?.login ?? null,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    repo: pr.repository.nameWithOwner,
    branch: pr.headRefName,
    isDraft: pr.isDraft,
    approvals: opinions.filter(r => r.state === 'APPROVED').length,
    changesRequested: opinions.filter(r => r.state === 'CHANGES_REQUESTED').length,
    pendingReviewers: detail.reviewRequests.totalCount,
    decision: detail.reviewDecision,
    checks,
    hasConflicts: readiness === 'conflicts',
    readiness,
    blockedBecause,
  }
}

export type NewNote = { id: string; who: string; text: string; kind: 'comment' | 'approved' | 'changes' }

// Every comment and review on a PR, by others, oldest first.
export function notesOf(detail: PrDetail, me: string): NewNote[] {
  const notes: NewNote[] = []
  const add = (n: Note, kind: NewNote['kind']) => {
    const who = n.author?.login ?? 'someone'

    if (who !== me) {
      notes.push({ id: n.id, who, text: n.body.replace(/\s+/g, ' ').trim(), kind })
    }
  }

  for (const r of detail.reviews.nodes) {
    if (r.state === 'APPROVED') {
      add(r, 'approved')
    } else if (r.state === 'CHANGES_REQUESTED') {
      add(r, 'changes')
    } else if (r.body.trim() !== '') {
      add(r, 'comment')
    }
  }

  for (const c of detail.comments.nodes) {
    add(c, 'comment')
  }

  for (const t of detail.reviewThreads.nodes) {
    for (const c of t.comments.nodes) {
      add(c, 'comment')
    }
  }

  return notes
}

export function quote(text: string, room = 60): string {
  if (text === '') {
    return ''
  }

  return text.length > room ? `“${text.slice(0, room - 1)}…”` : `“${text}”`
}

// What one toast says about the new notes on one PR.
export function toastFor(number: number, fresh: readonly NewNote[]): string | null {
  const first = fresh[0]

  if (first === undefined) {
    return null
  }

  if (fresh.length > 1) {
    const people = [...new Set(fresh.map(n => n.who))]
    return `💬 ${fresh.length} new review notes on #${number} from ${people.slice(0, 3).join(', ')}`
  }

  if (first.kind === 'approved') {
    return `✔ ${first.who} approved #${number}`
  }

  if (first.kind === 'changes') {
    return `✖ ${first.who} requested changes on #${number} ${quote(first.text, 50)}`.trim()
  }

  return `💬 ${first.who} on #${number}: ${quote(first.text)}`
}

export function since(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))

  if (seconds < 60) {
    return `${seconds}s ago`
  }

  const minutes = Math.round(seconds / 60)

  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}
