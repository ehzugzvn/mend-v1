# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ehzugzvn/mend-v1/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/ehzugzvn/mend-v1/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four
formats, and mend reads all of them exactly as `SPEC.md` specifies:

- **unified diffs** — sections and hunks, creations, deletions and renames, with wrong line numbers
  corrected by searching for the hunk's old lines near the stated position;
- **SEARCH/REPLACE blocks** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks headed by a path;
- **V4A patches** — `*** Begin Patch` … `*** End Patch` with Add / Delete / Update File sections,
  anchored chunks, end-of-file chunks and `*** Move to:` moves;
- **JSON tool calls** — one array of edit objects, or JSON Lines: `create`, `str_replace`, `insert`.

Old lines are matched at three tiers — exact, then ignoring trailing whitespace, then ignoring
leading and trailing whitespace (with re-indentation at the loosest tier) — because models drift
whitespace and indentation. Every edit in a patch is applied to a virtual copy of the tree in patch
order; if any edit fails, every failure is reported and **no file is written**. Paths are checked
for safety (no absolute paths, no `..`, no backslashes) before anything else about an edit.

## Running it

Node 22, standard library only — there is nothing to install:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the root of the tree). Omit it, or
  pass `-`, to read the patch from standard input.
- `--format=NAME` forces one format: `unified`, `search-replace`, `v4a` or `json`. The default,
  `auto`, detects the format from the patch text.
- `--check` does everything but write: the same output and exit code, and no file is created,
  changed or deleted.
- `--strict` matches old lines exactly (tier 0 only).
- `--` ends the options; everything after it is a positional argument.

## Output and exit codes

- Exit 0: one line per changed path (`A` added, `D` deleted, `M` modified, `R <old> -> <new>` for a
  move), sorted by byte order of the paths, then `ok: <n> files`.
- Exit 1: one `error: <code> <path>` line per failed edit (`no-match`, `ambiguous`, `missing`,
  `exists`, `unsafe`), in patch order, then `failed: <k> of <n> edits`. Nothing is written.
- Exit 2: a single line — `error: usage`, `error: no-patch`, `error: format`, or
  `error: parse <N>` naming the 1-based patch line at fault.

Files keep their own line breaks (CRLF stays CRLF) and their final line break; files an edit
creates are written with LF breaks. The full contract is `SPEC.md`.

## Checking it

The kit's practice set runs with:

    node check.ts <practice.json>

## License

MIT — see `LICENSE`.
