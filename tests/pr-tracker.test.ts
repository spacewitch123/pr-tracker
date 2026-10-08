import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { countChecks, readinessOf, toastFor } from '../hooks/pr-core'

const SURFACES = ['terminal', 'desktop'] as const

const BAND = {
  plugin: 'pr-tracker',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 140, scroll: { offset: 0, bodyRows: 19 }, view: {} },
} as const

const check = (name: string, conclusion: string | null, isRequired: boolean) => ({
  __typename: 'CheckRun',
  name,
  status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
  conclusion,
  isRequired,
})

type Fixture = {
  threadComments: Array<{ id: string; body: string; who: string }>
  mergeable: string
  mergeState: string
}

function detail(number: number, f: Fixture, decision: string, opinions: string[], requests: number) {
  return {
    pullRequest: {
      number,
      mergeable: f.mergeable,
      mergeStateStatus: f.mergeState,
      reviewDecision: decision,
      latestOpinionatedReviews: { nodes: opinions.map((state, i) => ({ state, author: { login: `rev${i}` } })) },
      reviewRequests: { totalCount: requests },
      reviews: { nodes: [] },
      comments: { nodes: [] },
      reviewThreads: {
        nodes: [{ comments: { nodes: f.threadComments.map(c => ({ id: c.id, body: c.body, url: 'u', author: { login: c.who } })) } }],
      },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [check('Lint', 'SUCCESS', true), check('Typecheck', 'FAILURE', true), check('Build', null, true), check('Docs', 'FAILURE', false)],
                },
              },
            },
          },
        ],
      },
    },
  }
}

function world(on: On, f: Fixture, toasts: string[], branch = 'feature/pricing', remote: string | null = 'git@github.com:acme/web.git') {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  const queries: string[] = []
  on('process.run', ($, e) => {
    const answer = (exitCode: number, stdout: string) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

    if (e.argv[0] === 'git') {
      if (e.argv[1] === 'remote') {
        return remote === null ? answer(2, '') : answer(0, `${remote}\n`)
      }
      return answer(0, `${branch}\n`)
    }

    const query = e.argv.find(a => a.startsWith('query=')) ?? ''
    queries.push(query)

    if (query.includes('viewer')) {
      const pr = (number: number, title: string, headRefName: string, author: string, isDraft = false) => ({
        number, title, url: `https://x/${number}`, isDraft, headRefName, repository: { nameWithOwner: 'acme/web' }, author: { login: author },
      })
      return answer(
        0,
        JSON.stringify({
          data: {
            viewer: { login: 'me' },
            mine: { nodes: [pr(368, 'Unique form input ids', 'feature/ids', 'me'), pr(325, 'Add a yearly pricing plan', 'feature/pricing', 'me'), pr(399, 'Half-done proxy work', 'feature/proxy', 'me', true)] },
            review: { nodes: [pr(412, 'Speed up the booking list', 'feature/speed', 'mir')] },
          },
        }),
      )
    }

    const details: Record<number, unknown> = {
      368: detail(368, { threadComments: [], mergeable: 'MERGEABLE', mergeState: 'CLEAN' }, 'APPROVED', ['APPROVED', 'APPROVED'], 0),
      325: detail(325, f, 'CHANGES_REQUESTED', ['APPROVED', 'CHANGES_REQUESTED'], 1),
      412: detail(412, { threadComments: [], mergeable: 'MERGEABLE', mergeState: 'BLOCKED' }, 'REVIEW_REQUIRED', [], 1),
    }
    const order = [...query.matchAll(/pullRequest\(number: (\d+)\)/g)].map(m => Number(m[1]))

    return answer(0, JSON.stringify({ data: Object.fromEntries(order.map((n, i) => [`p${i}`, details[n] ?? null])) }))
  })

  return { clock, queries }
}

async function texts(ui: { findAll: (q: { type: string }) => Promise<Array<{ text?: string }>> }) {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('')
}

async function start($: Engine) {
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
}

test('required checks count only required ones, reruns counted once', () => {
  const counts = countChecks([check('Lint', 'FAILURE', true), check('Lint', 'SUCCESS', true), check('Build', null, true), check('Docs', 'FAILURE', false)] as never)
  expect(counts).toEqual({ passed: 1, failed: 0, pending: 1, total: 2, isRequiredOnly: true })

  expect(readinessOf({ isDraft: false }, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', reviewDecision: 'APPROVED' }, counts).readiness).toBe('conflicts')
  expect(readinessOf({ isDraft: false }, { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, { ...counts, pending: 0 })).toEqual({
    readiness: 'blocked',
    blockedBecause: 'needs approval',
  })
  expect(toastFor(325, [{ id: 'a', who: 'mir', text: 'Can we rename this?', kind: 'comment' }])).toBe('💬 mir on #325: “Can we rename this?”')
})

test('the bar shows reviews, required checks, conflicts and readiness, current branch first', async ($, on) => {
  const toasts: string[] = []
  const { clock } = world(on, { threadComments: [], mergeable: 'CONFLICTING', mergeState: 'DIRTY' }, toasts)
  await start($)
  await clock.advance(10)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const all = await texts(ui)
    expect(all).toMatch(/⎇ web  2 yours · 1 to review/)
    expect(all).toMatch(/▶ #325 Add a yearly pricing plan/)
    expect(all).toMatch(/#325.*✔1 ✖1 ◷1  req ✔1 ✖1 ◷1  ⚠   CONFLICTS /)
    expect(all).toMatch(/◎ #412 Speed up the booking list · @mir/)
    expect(all).toMatch(/• #368 Unique form input ids.*✔2 ✖0 ◷0.* READY /)
    expect(all).not.toMatch(/#399/)
    expect(all.indexOf('#325') < all.indexOf('#412')).toBe(true)
    expect(all.indexOf('#412') < all.indexOf('#368')).toBe(true)
    await ui.unmount()
  }

  expect(toasts).toHaveLength(0)
})

test('a new review comment raises a toast, old ones never do', async ($, on) => {
  const toasts: string[] = []
  const fixture = { threadComments: [{ id: 'c1', body: 'old note', who: 'mir' }], mergeable: 'MERGEABLE', mergeState: 'BLOCKED' }
  const { clock } = world(on, fixture, toasts)
  await start($)
  await clock.advance(10)
  expect(toasts).toHaveLength(0)

  fixture.threadComments.push({ id: 'c2', body: 'Can we rename this helper?', who: 'mir' })
  fixture.threadComments.push({ id: 'c3', body: 'my own reply', who: 'me' })
  await clock.advance(60_000)
  expect(toasts).toEqual(['💬 mir on #325: “Can we rename this helper?”'])
})

test('/prs lists every PR and /prs off hides the bar', async ($, on) => {
  const toasts: string[] = []
  const { clock } = world(on, { threadComments: [], mergeable: 'MERGEABLE', mergeState: 'BLOCKED' }, toasts)
  await start($)
  await clock.advance(10)

  const listed = await $.command.run({ command: 'prs', args: '' } as never)
  expect(listed.text).toMatch(/Pull requests in acme\/web/)
  expect(listed.text).toMatch(/#412 Speed up the booking list · waiting on your review \(by mir\)/)
  expect(listed.text).toMatch(/BLOCKED \(changes requested\)/)

  await $.command.run({ command: 'prs', args: 'off' } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await texts(ui)).not.toMatch(/Pull requests/)
  await ui.unmount()
})

test('a missing sign-in shows a calm hint instead of breaking', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.render', { component: 'AbovePrompt' }, () => ({ type: 'engine', ref: 0 }))
  on('process.run', ($, e) =>
    e.argv[0] === 'git'
      ? { value: { exitCode: 0, stdout: 'https://github.com/acme/web.git\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      : { value: { exitCode: 1, stdout: '', stderr: 'To get started with GitHub CLI, please run: gh auth login', isStdoutTruncated: false, isStderrTruncated: false } },
  )
  await start($)
  await clock.advance(10)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await texts(ui)).toMatch(/sign in with: gh auth login/)
  await ui.unmount()
})

test('asks GitHub only for this project, your PRs and your reviews, never drafts', async ($, on) => {
  const { clock, queries } = world(on, { threadComments: [], mergeable: 'MERGEABLE', mergeState: 'CLEAN' }, [])
  await start($)
  await clock.advance(10)
  const list = queries.find(q => q.includes('viewer')) ?? ''
  expect(list).toMatch(/repo:acme\/web is:pr is:open draft:false author:@me/)
  expect(list).toMatch(/repo:acme\/web is:pr is:open draft:false review-requested:@me/)
})

test('outside a GitHub project the bar stays hidden', async ($, on) => {
  const { clock } = world(on, { threadComments: [], mergeable: 'MERGEABLE', mergeState: 'CLEAN' }, [], 'main', null)
  await start($)
  await clock.advance(10)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await texts(ui)).toBe('')
  await ui.unmount()
  expect((await $.command.run({ command: 'prs', args: '' } as never)).text).toMatch(/isn't a GitHub project/)
})
