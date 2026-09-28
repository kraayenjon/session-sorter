---
name: session-sorter
description: Sort ungrouped Claude Code sessions into Session Manager groups in Cursor or VS Code. Use when the user asks to organize, group, sort, label or clean up their Claude Code sessions or chats, or mentions the "Ungrouped" list in the Session Manager.
---

# session-sorter

Sorts the "Ungrouped" sessions in the Claude Code Session Manager into groups. The user approves the categories. Jev sorts each session into one of them. Nothing moves until the user confirms.

The command is `session-sorter`. If it is missing, tell the user to run `npm link` in the session-sorter repository. Every command works on the current folder's project; add `--project <path>` for another one.

## Steps

1. **Look.** Run `session-sorter scan`, and then `session-sorter titles`. Tell the user how many sessions are ungrouped.

2. **Propose categories.** Read the titles and draft 5–12 categories. Pick **one axis** and say which one you chose: by product (Kaptex, AiSelfi, madewithjev…) or by kind of work (SEO, content, bugs, infra…). Mixing the two splits sessions unpredictably, for example "madewithjev SEO audit". Give each category a one-line description that says what belongs in it. Jev reads the description, not only the name.
   Run `session-sorter categories` to create the file. Its existing groups are prefilled; keep those names exactly. Write your draft into the path it prints, then **show the list to the user and wait for their approval or edits.** Do not classify before they approve.

3. **Sort.** Run `session-sorter classify`. For a first look at a large list, add `--limit 20`. Report the move, review and leave counts and the cost.

4. **Review with the user.** Run `session-sorter review` and summarize it: what moves where, and which sessions are in "review" (Jev was unsure). Apply any changes the user asks for by editing `plan.json` (`decision`: move | review | leave, or a different `category`).

5. **Hand over the apply step.** You are running inside the editor, and the editor must be fully closed for the change to stick. So **do not run `apply --yes` yourself.** Run `session-sorter apply` (no `--yes`) to show the final changes. Then give the user these exact steps:
   1. Quit Cursor completely (Cmd+Q).
   2. Open the Terminal app and run: `cd <project path> && session-sorter apply --yes`. Add `--include-review` if they want the unsure sessions moved as well.
   3. Reopen Cursor.

   If something looks wrong afterwards, the reverse is the same, with `session-sorter undo --yes`.

## Rules

- Never run `apply --yes` or `undo --yes` from inside the editor.
- Never invent a category the user did not approve.
- Sessions that are already in a group are never moved.
- Titles and prompts are sent to Jev, clipped and with common key formats redacted. There is no way yet to exclude single sessions. If the user has sessions they do not want sent, tell them before step 3, so they can file those by hand first; grouped sessions are never sent.
