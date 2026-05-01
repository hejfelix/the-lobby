# Generate Conventional Commit Message

Analyse the current staged and unstaged changes, then output a ready-to-run git commit command.

## Steps

1. Run `git diff HEAD` to see all changes (staged + unstaged). If the working tree is clean, run `git diff HEAD~1` to show the last commit instead.

2. Determine the **conventional commit type** from the diff:
    - `feat` — new feature or new slash command / bot capability
    - `fix` — bug fix
    - `refactor` — restructuring with no behaviour change
    - `style` — formatting / linting only
    - `docs` — documentation / README / CLAUDE.md only
    - `chore` — dependencies, config, tooling (pyproject.toml, Dockerfile, Makefile, settings)
    - `test` — test files only

3. Determine an optional **scope** (one short noun, lowercase, no spaces) if the change is clearly scoped to a single area, e.g. `bot`, `stats`, `leaderboard`, `deps`, `hooks`. Omit the scope if the change spans many areas.

4. Write a **subject line** (≤72 chars, imperative mood, no trailing period) and a **bullet-list body** summarising all notable changes.

5. Output **only** the following snippet — nothing before, nothing after:

```
git commit -am "type(scope): subject

- change one
- change two"
```

Do **not** use heredocs, shell substitution (`$(...)`) or any embedded shell code — the command must be pasteable as-is.
Do **not** include `Co-Authored-By` or any attribution trailer unless the user explicitly asks.
Do **not** stage files yourself — use `-a` so git stages all tracked changes automatically.
Do **not** run the command — only print it.