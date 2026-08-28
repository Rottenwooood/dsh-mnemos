#!/usr/bin/env bash
# One-command verification for dsh-mnemos (P3.4 engineering reliability).
# Runs, in order:
#   1. unit + wiring tests (from the plugin repo)
#   2. deterministic eval (scorecard)   — from the harness monorepo
#   3. ABI conformance suite            — from the harness monorepo
#   4. real-composition (real registry) — from the harness monorepo
set -euo pipefail

MNEMOS="${MNEMOS:-/home/c6h4o2/dsh-mnemos}"
HARNESS="${HARNESS:-/home/c6h4o2/dev/deepseek-harness}"

echo "== 1/4 typecheck + unit tests =="
(cd "$MNEMOS" && pnpm run typecheck && pnpm run test)

echo "== 2/4 deterministic eval (scorecard) =="
(cd "$HARNESS" && node --import tsx/esm "$MNEMOS/scripts/eval/run-eval.mts")

echo "== 3/4 ABI conformance =="
(cd "$HARNESS" && node --import tsx/esm "$MNEMOS/scripts/conformance.mts" | tail -1)

echo "== 4/4 real-composition =="
(cd "$HARNESS" && node --import tsx/esm "$MNEMOS/scripts/verify-real-composition.mts" | tail -1)

echo "ALL CHECKS DONE"
