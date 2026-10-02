# session-sorter

> Claude Code lets you file sessions into groups. Nobody does. This sorts the "Ungrouped" pile for you, with Jev.

The Claude Code extension for Cursor and VS Code has a Session Manager with groups. After a few weeks, "Ungrouped" holds a hundred sessions nobody can find. session-sorter reads them, helps you settle on categories, and has [TypeSafe's Jev](https://docs.typesafe.ai) put each session in one. Nothing moves until you have seen the plan and confirmed it.

```
scan sessions  ->  approve categories  ->  one Jev call each  ->  review the plan  ->  apply (and undo)
```

On a real project with 101 ungrouped sessions, Jev sorted all of them in **7.9 s** for **$0.003** in total: 72 moved, 23 flagged for review, 6 left alone.

```
$ session-sorter review
MOVE (72)
  FEATURES
    1.00  Mobile navbar restructuring
    1.00  Main feed sort options
  SEO
    1.00  GSC video indexing and results serving
    0.97  madewithjev.com SEO audit
  SPONSORS
    1.00  Sponsors to weekly subscriptions
  ...

REVIEW (23) — moved only with --include-review
  SPONSORS
    0.59  Stripe account setup and deployment   [or FEATURES (0.35)]
  ...

LEAVE (6)
  other
    0.48  Gmail email classifier app validation   [or STRATEGY (0.27)]
```

## Quick start

You need macOS, Node 21+, the Claude Code extension in Cursor or VS Code, and one Jev key: a [Vercel AI Gateway](https://vercel.com/ai-gateway) key (`AI_GATEWAY_API_KEY`) or a [TypeSafe](https://console.typesafe.ai/keys) key (`TYPESAFE_API_KEY`).

```bash
git clone https://github.com/kraayenjon/session-sorter
cd session-sorter && npm link
export AI_GATEWAY_API_KEY=...
```

Then, inside the project folder whose sessions you want to sort:

```bash
session-sorter scan          # counts only
session-sorter titles        # the ungrouped list
session-sorter categories    # creates categories.json; edit it
session-sorter classify      # Jev sorts; add --limit 20 for a first look
session-sorter review        # the plan
session-sorter apply         # shows exactly what would change, writes nothing
```

To write the change:

1. **Quit Cursor completely** (Cmd+Q, not just close the window).
2. In the Terminal app: `session-sorter apply --yes`. Add `--include-review` to move the unsure sessions too.
3. Reopen Cursor.

Changed your mind? Quit Cursor and run `session-sorter undo --yes`.

**VS Code** instead of Cursor: add `--app vscode` to every command. Another project: add `--project <path>`.

### Or let Claude do it

Install the bundled skill as a plugin, in Claude Code:

```
/plugin marketplace add kraayenjon/session-sorter
/plugin install session-sorter@session-sorter
```

Then ask Claude to "sort my ungrouped sessions". It drafts categories from your titles and waits for your approval before anything is sent to Jev. It never runs `apply --yes` itself, because the editor it runs in has to be closed for that.

## Why

The Session Manager has groups, but filing every session by hand is a chore nobody keeps up with. Search only helps if you remember the title. Grouping a hundred sessions is exactly the kind of small, repetitive judgement call Jev is built for: cheap, fast, and with a confidence score so you know which calls to check.

## How it works

1. **Scan.** Reads the session files in `~/.claude/projects/<project>/`. For each one it takes the title the Session Manager shows, plus the first and last thing you asked. It reads the extension's groups and lists what is in no group and not archived.
2. **Categories.** You decide them. Write them yourself, or let Claude draft them from your titles. Each category gets a one-line description, because the description is what Jev reads. Existing groups are prefilled.
3. **Classify.** One Jev call per session: a single Choice over your categories, plus "other" for "nothing fits". Jev returns its pick, a confidence for that pick, and a probability for every category.
4. **Review.** The confidence decides what happens:

   | Jev's confidence | Decision |
   |---|---|
   | ≥ 0.80 | **move** |
   | 0.50 – 0.79 | **review**: listed, moved only with `--include-review` |
   | < 0.50, or "other" | **leave** in Ungrouped |

   The runner-up in brackets comes from the probabilities. Confidence is Jev's own score for its pick, separate from the probabilities, so on an unsure session the runner-up can show a higher number than the confidence. Those sessions end up in review or leave, which is the point.

   You can change any line in `plan.json` (`decision`: move | review | leave, or a different `category`) before applying.
5. **Apply.** Writes the groups. It needs the editor fully closed, backs up first, and `undo` reverses it.

Only ungrouped sessions move. A session you already filed stays where it is, and no group is renamed or deleted.

## Choosing categories

- **Pick one axis.** Group by product (Kaptex, AiSelfi, madewithjev) or by kind of work (SEO, content, bugs, infra). With both, "madewithjev.com SEO audit" can land in either.
- **Write the description for Jev.** "The Kaptex product: app, landing page, payments" sorts better than "Kaptex" alone.
- **5–12 categories** work well. A category that overlaps two others will end up nearly empty, with its sessions in review. If that happens, merge it or sharpen its description and run `classify` again. It costs a fraction of a cent.
- Anything that fits nothing goes to "other" and stays in Ungrouped. That is better than a forced guess.

## Why the editor has to be closed

The extension keeps its groups in the editor's own state database (`state.vscdb`), under the extension's entry, as `sessionGroups:<workspace folder>`. The editor holds that state in memory while it runs and writes it back on exit, so a change made while it runs would be silently overwritten. `apply` refuses if the editor is running. Before writing, it copies the whole database to `~/.session-sorter/<project>/backups/`, then changes that one key and nothing else.

This is not an official API. The format was read from Claude Code extension 2.1.283, and a future version could change it. `apply` writes only groups the extension itself accepts: an id, a name of at most 100 characters, and session ids, within the extension's limits of 100 groups and 1,000 grouped sessions.

## Keys

If both keys are set, `JEV_BACKEND=gateway|typesafe` picks one. `JEV_ENV_FILE=/path/to/.env` reads the key from an existing dotenv file, so it can stay in the project that owns it.

## Cost

One Jev call per ungrouped session, about $0.00003 each. The 101-session run above cost $0.003009. `classify` prints the exact cost. `scan`, `titles`, `review`, `apply` and `undo` make no Jev calls.

## Privacy

For each ungrouped session, Jev receives the title, the first request (up to 700 characters), the last request (up to 400), the git branch and the date. Common key formats (`sk-…`, `ghp_…`, `Bearer …`, `API_KEY=…`, long hex and base64) are redacted first. Nothing is sent for grouped or archived sessions. Tool output and file contents are never sent.

There is no way yet to leave out single ungrouped sessions, so file anything sensitive by hand first.

Everything else stays on your machine. `~/.session-sorter/<project>/` holds `categories.json`, `plan.json` and `backups/`. Nothing is written inside your project. Not affiliated with Anthropic.

## Development

```bash
npm test   # fixtures only: a fake ~/.claude, a fake state database, canned Jev answers
```

`src/sessions.mjs` reads sessions. `src/store.mjs` reads and writes the editor state. `src/classify.mjs` holds the Jev question and the bands. `src/jev.mjs` makes the call. `src/plan.mjs` turns a plan into groups. `src/cli.mjs` is the command line.

macOS only for now: the editor state paths are the macOS ones. Pull requests for Linux and Windows paths are welcome.

## Related

- [jev-linkedin-saved-classifier](https://github.com/kraayenjon/jev-linkedin-saved-classifier): turns LinkedIn saved posts into a filterable board, with Jev.
- [awesome-jev](https://github.com/kraayenjon/awesome-jev): a list of Jev resources.

## Credits

Jev by [TypeSafe](https://docs.typesafe.ai).

## License

MIT. See [LICENSE](LICENSE).

## More

For more Jev use cases, visit [madewithjev.com](https://madewithjev.com).

Built by Jon Kraayenbrink. Follow along:
[X](https://x.com/kraayenjon) ·
[Threads](https://www.threads.com/@kraayenjon) ·
[LinkedIn](https://www.linkedin.com/in/jonathan-kraayenbrink)
