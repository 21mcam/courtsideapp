# GitHub repo setup

End-to-end runbook for taking this codebase from a local working
directory to a GitHub repo with CI + branch protection. Captures the
exact sequence we walked through in Phase 0; the specific gotchas
below cost real time to debug, so they're called out.

## Prerequisites

- `gh` CLI installed (Homebrew: `brew install gh`)
- A GitHub account
- A repo created on GitHub (empty, no README, no .gitignore — we have
  our own)

## 1. First-time gh auth — get a token with the right scopes

This is the step that bit us. The default GitHub auth (e.g. a PAT
created with just "repo" scope, cached by macOS Keychain from previous
work) is **missing the `workflow` scope**, which GitHub requires for
any push that touches `.github/workflows/`. Symptom:

```
! [remote rejected] main -> main (refusing to allow a Personal Access
  Token to create or update workflow `.github/workflows/ci.yml`
  without `workflow` scope)
```

The fix is to log in via gh's browser-based OAuth flow with the
`workflow` scope explicitly requested:

```bash
gh auth login --git-protocol https --web -s workflow
```

This walks you through:
1. Pick GitHub.com (not Enterprise)
2. HTTPS for git operations
3. Web browser auth — gh prints an 8-digit code, opens GitHub, paste
   the code, click Authorize
4. gh stores the token

If you already used `gh` for something else and just need to add the
`workflow` scope to your existing auth, the shorthand is:

```bash
gh auth refresh -s workflow
```

Confirm:

```bash
gh auth status
# Should list: "Token scopes: 'gist', 'read:org', 'repo', 'workflow'"
```

## 2. Tell git to use gh for github.com auth (the credential-helper trap)

This is the **second** thing that bit us. Even after `gh auth login`
gets a token with the right scopes, git might still be using an old
cached PAT from `osxkeychain` (or the equivalent on Linux). The macOS
Keychain credential helper runs first, returns the old token, and git
never asks gh.

The fix: wire gh in as a git credential helper for github.com URLs
specifically (this takes precedence over the global `osxkeychain`
helper):

```bash
gh auth setup-git
```

Confirm with:

```bash
git config --get-all 'credential.https://github.com.helper'
# Should show: !/opt/homebrew/bin/gh auth git-credential
```

Now `git push` against github.com will use gh's stored token, which
has the `workflow` scope, and pushes that touch `.github/workflows/`
will succeed.

## 3. Initialize, commit, push

From the repo root:

```bash
git init -b main

# Sanity: confirm .env is gitignored
git check-ignore -v .env  # should print the matching .gitignore rule

# Stage + initial commit
git add .
git commit -m "chore: phase 0 foundation"

# Add the remote (HTTPS — gh manages auth)
git remote add origin https://github.com/YOUR-USER/YOUR-REPO.git
git push -u origin main
```

CI fires automatically on the push. Watch it:

```bash
gh run list --limit 1
gh run watch <run-id> --exit-status
```

## 4. Set branch protection on main

After the first CI run is green, lock down `main` so future changes
go through PRs and the CI status check is a hard gate.

```bash
gh api -X PUT /repos/YOUR-USER/YOUR-REPO/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["lint, build, migrations, smoke test"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

Settings explained:

| Setting | Why |
|---|---|
| `required_status_checks.contexts: ["lint, build, migrations, smoke test"]` | The CI job name from `.github/workflows/ci.yml`. Must match exactly. |
| `strict: true` | PR branch must be up to date with main before merge — catches "passes on stale branch but breaks on merge" |
| `required_approving_review_count: 0` | Solo dev: PRs are required, but no human approval beyond CI |
| `enforce_admins: false` | You can bypass in genuine emergencies. Flip to `true` to lock yourself out too. |
| `allow_force_pushes: false` | Prevents history rewrites |
| `allow_deletions: false` | Prevents accidental branch deletion |

Verify:

```bash
gh api /repos/YOUR-USER/YOUR-REPO/branches/main/protection --jq '{
  required_pr: .required_pull_request_reviews.required_approving_review_count,
  required_checks: .required_status_checks.contexts,
  strict: .required_status_checks.strict,
  enforce_admins: .enforce_admins.enabled
}'
```

## 5. The "required check is name-sensitive" trap

The status-check name in branch protection (`"lint, build, migrations,
smoke test"`) is matched **literally** against the CI job's name. If
you ever rename the job in `ci.yml`, the protection rule keeps waiting
for the old name, the new check never satisfies it, and merges block
forever.

If you rename the job:

1. Update `name:` in `ci.yml`
2. Update the protection rule with the new name:
   ```bash
   gh api -X PATCH /repos/YOUR-USER/YOUR-REPO/branches/main/protection/required_status_checks \
     -f 'contexts[]=NEW JOB NAME'
   ```

Or just don't rename the job. The current name is fine.

## Day-to-day flow after setup

```bash
git checkout -b feat/whatever
# work, commit
git push -u origin feat/whatever
gh pr create --fill          # or use the GitHub web UI
# wait for CI green
gh pr merge --merge          # CI gates the merge automatically
```

Direct push to `main` is rejected for non-admins. As an admin you
*can* still push directly (the `enforce_admins: false` setting), but
you'd have to consciously decide to bypass — no slipped-fingertip
direct pushes.

## Recovery

If gh auth ever goes weird (token revoked, lost laptop, scope drift):

```bash
# Wipe local gh state
gh auth logout

# Wipe macOS Keychain entries for github.com (so the old PAT doesn't
# stick around)
printf "host=github.com\nprotocol=https\n\n" | git credential-osxkeychain erase

# Start over from step 1
gh auth login --git-protocol https --web -s workflow
gh auth setup-git
```
