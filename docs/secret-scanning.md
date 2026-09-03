# Secret Scanning

CI runs [gitleaks](https://github.com/gitleaks/gitleaks) (see the `secret-scan`
job in `.github/workflows/ci.yml`) on every push and pull request. It scans
the diff for credential-shaped strings (API keys, private keys, tokens,
high-entropy secrets) and fails the build if one is found. Rule
configuration and path allowlisting live in `.gitleaks.toml` at the repo root.

## Backfill scan

The full git history was scanned once when this job was introduced
(PR closing #735) to confirm no existing commits contain a leaked credential.
No true positives were found in history at that time.

## Handling a true positive

If gitleaks flags a real credential (in CI or in a manual history scan):

1. **Rotate the credential immediately** with the issuing provider — treat it
   as compromised the moment it was committed, regardless of whether the
   repo is public.
2. **Do not just delete it in a new commit.** The secret remains in git
   history and is recoverable from any clone. Purge it from history with
   `git filter-repo` (preferred) or the BFG Repo-Cleaner, then force-push
   the rewritten history and have all collaborators re-clone.
3. **Invalidate cached history** on the hosting side (contact GitHub Support
   to purge cached views/forks if the repo is public and the exposure
   window was significant).
4. **Add a `.gitleaks.toml` allowlist entry only** for confirmed false
   positives (e.g. a fixture value that merely looks like a secret) —
   never to silence a real finding.
5. **File a short incident note** describing what leaked, for how long, and
   what was rotated, so the team has a record.
