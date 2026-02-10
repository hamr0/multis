# Definition of Done

## For each POC

A POC is "done" when:

1. **All exit criteria pass** — as defined in the POC plan
2. **Code loads without errors** — `node -e "require('./src/...')"` succeeds for all new/modified files
3. **No regressions** — existing commands still work
4. **Committed** — clean commit with descriptive message
5. **Docs updated** — implementation log, validation log, system-state if architecture changed

## For code changes

- No unused imports or dead code introduced
- Governance enforced (owner-only commands check `isOwner`)
- Audit logging for security-relevant actions
- Error messages are user-friendly (not stack traces)
- Beeper responses prefixed with `[multis]` to avoid cascade
