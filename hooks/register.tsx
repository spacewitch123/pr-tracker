import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { PrReadiness, TrackedPr } from '../types'
import { detailQuery, LIST_QUERY, notesOf, since, toastFor, toTracked } from './pr-core'
import type { ListAnswer, PrDetail } from './pr-core'

type Engine = EngineInterface
type Timer = { cancel: () => void }

const POLL_MS = 60_000
const AFTER_PUSH_MS = 4_000
const SHOWN = 3
const MAX_TOASTS = 3

const ACCENT = '#6366f1'
const GOOD = '#16a34a'
const BAD = '#e11d48'
const WAIT = '#d97706'

const prsAtom = atom({ plugin: 'pr-tracker', key: 'prs' } as const, [])
const totalAtom = atom({ plugin: 'pr-tracker', key: 'totalOpen' } as const, 0)
const branchAtom = atom({ plugin: 'pr-tracker', key: 'branch' } as const, null)
const syncedAtom = atom({ plugin: 'pr-tracker', key: 'syncedAt' } as const, null)
const errorAtom = atom({ plugin: 'pr-tracker', key: 'error' } as const, null)
const visibleAtom = atom({ plugin: 'pr-tracker', key: 'isVisible' } as const, true)

let poller: Timer | null = null
let isPolling = false
// Notes already seen, per PR. A PR seen for the first time is seeded quietly,
// so a launch or a reload never replays old comments as toasts.
const seen = new Map<string, Set<string>>()

const PUSHES = /\bgit\s+push\b|\bgh\s+pr\s+(create|merge|ready|edit|review|close|reopen)\b/

async function graphql($: Engine, query: string): Promise<unknown> {
  const ran = await $.process.run(['gh', 'api', 'graphql', '-f', `query=${query}`], { timeoutMs: 30_000 })

  if (ran.exitCode !== 0) {
    const reason = ran.stderr.trim()
    throw new Error(/auth|login|token/i.test(reason) ? 'auth' : reason.split('\n')[0] || 'gh failed')
  }

  return JSON.parse(ran.stdout)
}

async function currentBranch($: Engine): Promise<string | null> {
  try {
    const ran = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5_000 })
    const branch = ran.stdout.trim()

    return ran.exitCode === 0 && branch !== '' && branch !== 'HEAD' ? branch : null
  } catch {
    return null
  }
}

async function poll($: Engine): Promise<void> {
  if (isPolling) {
    return
  }

  isPolling = true

  try {
    const branch = await currentBranch($)
    const listed = (await graphql($, LIST_QUERY)) as ListAnswer
    const viewer = listed.data?.viewer

    if (viewer === undefined) {
      throw new Error('GitHub gave no answer')
    }

    const nodes = viewer.pullRequests.nodes
    const details =
      nodes.length === 0
        ? {}
        : (((await graphql($, detailQuery(nodes))) as { data?: Record<string, { pullRequest: PrDetail | null } | null> })
            .data ?? {})

    const prs: TrackedPr[] = []
    const toasts: string[] = []

    nodes.forEach((pr, i) => {
      const detail = details[`p${i}`]?.pullRequest

      if (detail === null || detail === undefined) {
        return
      }

      const tracked = toTracked(pr, detail)
      prs.push(tracked)

      const notes = notesOf(detail, viewer.login)
      const known = seen.get(tracked.key)

      if (known === undefined) {
        seen.set(tracked.key, new Set(notes.map(n => n.id)))
        return
      }

      const fresh = notes.filter(n => !known.has(n.id))
      fresh.forEach(n => known.add(n.id))
      const toast = toastFor(tracked.number, fresh)

      if (toast !== null) {
        toasts.push(toast)
      }
    })

    await update($, prsAtom, () => prs)
    await update($, totalAtom, () => viewer.pullRequests.totalCount)
    await update($, branchAtom, () => branch)
    const now = await $.clock.now()
    await update($, syncedAtom, () => now)
    await update($, errorAtom, () => null)

    for (const toast of toasts.slice(0, MAX_TOASTS)) {
      $.ui.toast(toast, { timeoutMs: 8_000 })
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const message =
      reason === 'auth'
        ? 'sign in with: gh auth login'
        : /ENOENT|not found|cannot start|spawn/i.test(reason)
          ? 'install the GitHub CLI (gh) to see your PRs'
          : `couldn't reach GitHub (${reason.slice(0, 60)})`
    await update($, errorAtom, () => message)
  } finally {
    isPolling = false
  }
}

function startPolling($: Engine): void {
  poller?.cancel()
  void poll($)
  poller = $.clock.every(POLL_MS, () => {
    void poll($)
  })
}

function stopPolling(): void {
  poller?.cancel()
  poller = null
}

const PILLS: Record<PrReadiness, { text: string; color: string }> = {
  ready: { text: ' READY ', color: GOOD },
  blocked: { text: ' BLOCKED ', color: BAD },
  conflicts: { text: ' CONFLICTS ', color: BAD },
  behind: { text: ' BEHIND ', color: WAIT },
  unstable: { text: ' UNSTABLE ', color: WAIT },
  draft: { text: ' DRAFT ', color: '#64748b' },
  checking: { text: ' CHECKING ', color: '#64748b' },
}

function ordered(prs: readonly TrackedPr[], branch: string | null): TrackedPr[] {
  const mine = prs.filter(p => p.branch === branch)

  return [...mine, ...prs.filter(p => p.branch !== branch)]
}

function summaryLine(pr: TrackedPr): string {
  const reviews = `✔${pr.approvals} ✖${pr.changesRequested} ◷${pr.pendingReviewers}`
  const checks = `${pr.checks.isRequiredOnly ? 'required' : 'checks'} ✔${pr.checks.passed} ✖${pr.checks.failed} ◷${pr.checks.pending}`
  const state = PILLS[pr.readiness].text.trim() + (pr.blockedBecause ? ` (${pr.blockedBecause})` : '')

  return `#${pr.number} ${pr.title} · ${pr.repo}\n   reviews ${reviews} · ${checks} · ${state}\n   ${pr.url}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'prs',
      description: 'PR Tracker: list your open PRs, or turn the bar on, off or refresh it',
      argumentHint: '[on|off|refresh]',
      immediate: true,
    })
    await update($, visibleAtom, () => true)
    startPolling($)

    return started
  })

  on('command.run', { command: 'prs' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'off') {
      await update($, visibleAtom, () => false)
      stopPolling()
      return { text: 'PR Tracker is off. Type /prs on to bring it back.' }
    }

    if (arg === 'on' || arg === 'refresh') {
      await update($, visibleAtom, () => true)
      startPolling($)
      return { text: arg === 'on' ? 'PR Tracker is on.' : 'Refreshing your pull requests…' }
    }

    if (arg !== '') {
      return { text: 'Use /prs, /prs on, /prs off or /prs refresh.' }
    }

    const prs = await read($, prsAtom)
    const error = await read($, errorAtom)
    const synced = await read($, syncedAtom)

    if (error !== null) {
      return { text: `PR Tracker: ${error}.` }
    }

    if (prs.length === 0) {
      return { text: synced === null ? 'PR Tracker is still loading.' : 'You have no open pull requests.' }
    }

    const branch = await read($, branchAtom)
    const lines = ordered(prs, branch).map(summaryLine)
    const now = await $.clock.now()

    return { text: `Your open pull requests (synced ${since(now - (synced ?? now))}):\n\n${lines.join('\n\n')}` }
  })

  // A push or a PR command by Claude: look again shortly, not in a minute.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)

    if (PUSHES.test(e.command) && (await read($, visibleAtom))) {
      $.clock.after(AFTER_PUSH_MS, () => {
        void poll($)
      })
    }

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)

    if (e.props.hasSurvey || !(await read($, visibleAtom))) {
      return below
    }

    const prs = await read($, prsAtom)
    const total = await read($, totalAtom)
    const branch = await read($, branchAtom)
    const synced = await read($, syncedAtom)
    const error = await read($, errorAtom)
    const { Box, Text } = $.ui.resolve(e)
    const columns = Math.max(30, e.props.bodyColumns)
    const isNarrow = columns < 90

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Text color={ACCENT} bold>
            {'⎇ Pull requests'}
          </Text>
          <Text dimColor>{synced === null ? '  loading…' : `  ${total} open`}</Text>
        </Box>
        {error !== null ? <Text color={WAIT}>{`● ${error}`}</Text> : <Text color={GOOD}>{synced === null ? '' : '● live'}</Text>}
      </Box>
    )

    const shown = ordered(prs, branch).slice(0, SHOWN)
    const rows = shown.map(pr => {
      const isHere = pr.branch === branch
      const pill = PILLS[pr.readiness]
      const why = pr.blockedBecause === null || isNarrow ? '' : ` ${pr.blockedBecause}`
      const reviews = isNarrow
        ? `  ✔${pr.approvals}`
        : `  ✔${pr.approvals} ✖${pr.changesRequested} ◷${pr.pendingReviewers}`
      const checks = isNarrow
        ? `  ${pr.checks.passed}/${pr.checks.total}`
        : `  ${pr.checks.isRequiredOnly ? 'req' : 'checks'} ✔${pr.checks.passed} ✖${pr.checks.failed} ◷${pr.checks.pending}`
      const conflict = pr.hasConflicts ? '  ⚠' : ''
      const fixed = 2 + `#${pr.number} `.length + reviews.length + checks.length + conflict.length + 2 + pill.text.length + why.length
      const room = Math.max(6, columns - fixed)
      const title = pr.title.length > room ? `${pr.title.slice(0, room - 1)}…` : pr.title.padEnd(room)

      return (
        <Box flexDirection="row">
          <Text color={isHere ? ACCENT : undefined} dimColor={!isHere}>
            {isHere ? '▶ ' : '• '}
          </Text>
          <Text bold>{`#${pr.number} `}</Text>
          <Text dimColor={!isHere}>{title}</Text>
          <Text color={pr.changesRequested > 0 ? BAD : pr.approvals > 0 ? GOOD : WAIT}>{reviews}</Text>
          <Text color={pr.checks.failed > 0 ? BAD : pr.checks.pending > 0 ? WAIT : GOOD}>{checks}</Text>
          <Text color={BAD} bold>
            {conflict}
          </Text>
          <Text>{'  '}</Text>
          <Text inverse bold color={pill.color}>
            {pill.text}
          </Text>
          <Text dimColor>{why}</Text>
        </Box>
      )
    })

    const more =
      total > shown.length ? [<Text dimColor>{`  +${total - shown.length} more · type /prs to see them all`}</Text>] : []
    const empty = synced !== null && prs.length === 0 && error === null ? [<Text dimColor>{'  No open pull requests'}</Text>] : []

    const bar: RenderElement = (
      <Box flexDirection="column">
        {header}
        {rows}
        {more}
        {empty}
      </Box>
    )

    if (below.type === 'engine') {
      return bar
    }

    return (
      <Box flexDirection="column">
        {below}
        {bar}
      </Box>
    )
  })
}
