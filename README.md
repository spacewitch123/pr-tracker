# PR Tracker

Your open pull requests, pinned above the Claude Code prompt and kept up to date.

```
⎇ Pull requests  5 open                                                        ● live
▶ #325 Add a yearly pricing plan     ✔1 ✖1 ◷1  req ✔3 ✖1 ◷0  ⚠   CONFLICTS
• #368 Unique form input ids         ✔2 ✖0 ◷0  req ✔4 ✖0 ◷0       READY
• #399 Trusted proxy depth limiter   ✔0 ✖0 ◷2  req ✔2 ✖0 ◷2       BLOCKED checks running
  +2 more · type /prs to see them all
```

- **Reviews:** `✔` approved, `✖` changes requested, `◷` reviewers still pending.
- **Checks:** passed, failed and running. When the repository has required checks, only those count (marked `req`). A rerun counts once.
- **⚠ Conflicts:** the branch conflicts with its base.
- **Merge readiness:** `READY`, `BLOCKED` (with the reason: changes requested, needs approval, checks failing or checks running), `CONFLICTS`, `BEHIND`, `UNSTABLE`, `DRAFT`, or `CHECKING` while GitHub works it out.
- **▶** marks the PR for the branch you're on, which always comes first.
- **Toasts** pop up when someone else comments, approves or requests changes. Comments that were already there when you started are never replayed.

It refreshes every minute, and a few seconds after Claude pushes or runs a `gh pr` command.

## Needs

The [GitHub CLI](https://cli.github.com), signed in (`gh auth login`). If it's missing or signed out, the bar says so instead of breaking.

## Install

Type this at the prompt of a Claude Code terminal session:

```
/plugin install pr-tracker --marketplace spacewitch123/pr-tracker
```

## Commands

- `/prs` lists all your open PRs, with links.
- `/prs refresh` checks again now.
- `/prs off` and `/prs on` hide and show the bar.

## Cost and privacy

PR Tracker uses no Claude tokens: it talks to GitHub through your own `gh`, two read-only GraphQL requests a minute, and nothing leaves your machine except those requests. It shares the space above the prompt with other mods such as [Clean View](https://github.com/spacewitch123/clean-view) and [Pulse](https://github.com/spacewitch123/pulse).

## For developers

```
claude plugin validate .
claude plugin test .
```

State under `pr-tracker` (`prs`, `totalOpen`, `branch`, `syncedAt`, `error`, `isVisible`) is typed in `types/index.d.ts`.
