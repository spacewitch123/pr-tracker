# PR Tracker

Your open pull requests, pinned above the Claude Code prompt and kept up to date.

```
⎇ invicta  2 yours · 1 to review                                             ● live
▶ #1552 Booking overlap fix              ✔1 ✖0 ◷0  req ✔4 ✖0 ◷0  ⚠   CONFLICTS
◎ #1561 Speed up the booking list · @mir ✔0 ✖0 ◷1  req ✔3 ✖0 ◷1       BLOCKED checks running
• #1540 Guest search filters             ✔2 ✖0 ◷0  req ✔4 ✖0 ◷0       READY
```

**Only what matters here.** PR Tracker follows the project folder Claude Code is open in, using its `origin` (or `upstream`) GitHub remote. Open it in `invicta` and you see invicta's PRs only. It shows:

- PRs **you wrote**, and
- PRs **waiting on your review** (`◎`, with the author's name).

Draft PRs are never shown. Outside a GitHub project, the bar stays out of the way.

- **Reviews:** `✔` approved, `✖` changes requested, `◷` reviewers still pending.
- **Checks:** passed, failed and running. When the repository has required checks, only those count (marked `req`). A rerun counts once.
- **⚠ Conflicts:** the branch conflicts with its base.
- **Merge readiness:** `READY`, `BLOCKED` (with the reason: changes requested, needs approval, checks failing or checks running), `CONFLICTS`, `BEHIND`, `UNSTABLE`, or `CHECKING` while GitHub works it out.
- **Order:** `▶` marks your PR for the branch you're on, which comes first. Reviews waiting on you come next.
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

- `/prs` lists this project's PRs (yours and your reviews), with links.
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
