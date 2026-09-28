# session-sorter

**Sort the "Ungrouped" pile in the Claude Code Session Manager into groups, with Jev.**

The Claude Code extension for Cursor and VS Code lets you file sessions into groups. Few people do, and after a few weeks "Ungrouped" holds 90 sessions nobody can find. session-sorter reads them, helps you settle on categories, and has [Jev](https://docs.typesafe.ai) put each session in one. Nothing moves until you have seen the plan and confirmed it.

```
$ session-sorter review
MOVE (4)
  Infra & costs
    1.00  Vercel Costs
  SEO
    0.98  madewithjev.com SEO audit
  madewithjev
    1.00  Sponsors open slot availability
  Kaptex
    1.00  Kaptex Stripe webhook

LEAVE (1)
  other
    1.00  hola
```

(A live run on five made-up sessions. The five Jev calls cost $0.000107 in total.)

## How it works

1. **scan** reads the session files in `~/.claude/projects/<project>/`. For each one it takes the title the Session Manager shows, plus the first and last thing you asked. It reads the extension's groups, then lists what is not in any group and is not archived.
2. **categories**: you decide on the categories. You write them, or Claude drafts them from your titles with the bundled skill, and you approve. Each category gets a one-line description, because that description is what Jev reads. Your existing groups are prefilled.
3. **classify**: one Jev call per session. A single Choice over your categories, plus "other" for "nothing fits". Jev returns a probability for every category. Cost: about $0.00002 per session.
4. **review** shows the plan:

   | Jev's confidence | Decision |
   |---|---|
   | ≥ 0.80 | **move** |
   | 0.50 – 0.79 | **review**: listed, moved only with `--include-review` |
   | < 0.50, or "other" | **leave** in Ungrouped |

   You can change any line in `plan.json` before applying.
5. **apply** writes the groups. It needs the editor fully closed (see below), backs up first, and `undo` reverses it.

Only ungrouped sessions move. A session you already filed stays where it is, and no group is renamed or deleted.

## Install

```bash
git clone https://github.com/kraayenjon/session-sorter && cd session-sorter && npm link
```

Then set a Jev key. Either one works:

- `AI_GATEWAY_API_KEY`, from [vercel.com/ai-gateway](https://vercel.com/ai-gateway)
- `TYPESAFE_API_KEY`, from [console.typesafe.ai/keys](https://console.typesafe.ai/keys)

If both are set, `JEV_BACKEND=gateway|typesafe` picks one. `JEV_ENV_FILE=/path/to/.env` reads the key from an existing dotenv file.

To have Claude run the steps for you, install the skill as a plugin, in Claude Code:

```
/plugin marketplace add kraayenjon/session-sorter
/plugin install session-sorter@session-sorter
```

Then ask Claude to "sort my ungrouped sessions". It proposes categories and waits for your approval before anything is sent to Jev.

## Use

Run the commands inside the project folder whose sessions you want to sort, or pass `--project <path>`.

```bash
session-sorter scan          # counts only
session-sorter titles        # the ungrouped list
session-sorter categories    # creates ~/.session-sorter/<project>/categories.json; edit it
session-sorter classify      # Jev sorts; add --limit 20 for a first look
session-sorter review        # the plan
session-sorter apply         # shows exactly what would change, writes nothing
```

To write the change:

1. **Quit Cursor completely** (Cmd+Q, not just close the window).
2. In the Terminal app: `session-sorter apply --yes`. Add `--include-review` to move the unsure sessions too.
3. Reopen Cursor.

`session-sorter undo --yes` (with Cursor quit) restores this project's groups from before the last apply. Other projects and settings are not touched.

**VS Code** instead of Cursor: add `--app vscode` to every command.

## Why the editor has to be closed

The extension keeps its groups in the editor's own state database (`state.vscdb`), under the extension's entry, as `sessionGroups:<workspace folder>`. The editor holds that state in memory while it runs and writes it back on exit, so a change made while it runs would be silently overwritten. `apply` checks that the editor is not running and refuses if it is. Before writing, it copies the whole database to `~/.session-sorter/<project>/backups/`, then changes that one key and nothing else.

This is not an official API. The format was read from Claude Code extension 2.1.283, and a future version could change it. `apply` writes only groups the extension itself accepts: an id, a name of at most 100 characters, and session ids, within the extension's limits of 100 groups and 1,000 grouped sessions.

## Choosing categories

- **Pick one axis.** Group either by product (Kaptex, AiSelfi, madewithjev) or by kind of work (SEO, content, bugs, infra). With both, "madewithjev.com SEO audit" can land in either one. In the example above it went to SEO.
- **Write the description for Jev.** "The Kaptex product: app, landing page, payments" sorts better than "Kaptex" alone.
- **5–12 categories** work well. Anything that fits none of them goes to "other" and stays in Ungrouped. That is better than a forced guess.

## What is sent to Jev

For each ungrouped session: the title, the first request (up to 700 characters), the last request (up to 400), the git branch and the date. Common key formats (`sk-…`, `ghp_…`, `Bearer …`, `API_KEY=…`, long hex and base64) are redacted first. Nothing is sent for grouped or archived sessions. There is no way yet to leave out single ungrouped sessions, so file anything sensitive by hand first. Tool output and file contents are never sent.

## Files

`~/.session-sorter/<project>/` holds `categories.json`, `plan.json` and `backups/`. Nothing is written inside your project.

## Development

```bash
npm test   # fixtures only: a fake ~/.claude, a fake state database, canned Jev answers
```

`src/sessions.mjs` reads sessions. `src/store.mjs` reads and writes the editor state. `src/classify.mjs` holds the Jev question and the bands. `src/plan.mjs` turns a plan into groups. `src/cli.mjs` is the command line.

macOS only for now: the editor state paths are the macOS ones.

## Related

- [jev-gates](https://github.com/kraayenjon/jev-gates): Jev as a decision layer inside Claude Code.
- [madewithjev.com](https://madewithjev.com): 750+ things people have built with Jev.

MIT. Built by [Jon Kraayenbrink](https://madewithjev.com/about).
