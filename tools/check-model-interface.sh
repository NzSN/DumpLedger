#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mirrors_root=${MIRRORS_ROOT:-/home/nzsn/Repos/Mirrors}
compiler="$mirrors_root/.lake/build/bin/model_interface_gen"
evidence="$repo_root/test/fixtures/mbt/traces/01-accepted-partial-delete.itf.json"
coverage="$repo_root/model-interface/DumpLedger.mirror-interface.coverage.json"
check_tmp=$(mktemp -d)
actual_coverage="$check_tmp/coverage.json"
trap 'rm -rf "$check_tmp"' EXIT HUP INT TERM

expect_preflight_failure() {
  fixture=$1
  expected_code=$2
  label=$3
  stdout_path="$check_tmp/$label.stdout"
  stderr_path="$check_tmp/$label.stderr"

  if "$compiler" preflight \
      --lock "$repo_root/model-interface/DumpLedger.mirror-interface.lock.json" \
      --trace "$repo_root/test/fixtures/mbt/negative/$fixture" \
      --diagnostics json >"$stdout_path" 2>"$stderr_path"; then
    echo "negative model-interface fixture unexpectedly passed: $fixture" >&2
    exit 1
  fi

  if ! grep -Fq "\"code\":\"$expected_code\"" "$stderr_path"; then
    echo "negative model-interface fixture returned the wrong diagnostic: $fixture" >&2
    cat "$stderr_path" >&2
    exit 1
  fi
}

"$compiler" check \
  --spec "$repo_root/specs/DumpLedger.tla" \
  --contract "$repo_root/model-interface/DumpLedger.mirror-interface.json" \
  --evidence "$evidence" \
  --param-var parameters \
  --lock "$repo_root/model-interface/DumpLedger.mirror-interface.lock.json" \
  --target mirrorecma-v1 \
  --out "$repo_root/src/generated/dump-ledger" \
  --diagnostics json

"$compiler" preflight \
  --lock "$repo_root/model-interface/DumpLedger.mirror-interface.lock.json" \
  --trace "$repo_root/test/fixtures/mbt/traces" \
  --require-all-actions >"$actual_coverage"

if ! cmp -s "$coverage" "$actual_coverage"; then
  echo "model-interface coverage report is stale" >&2
  diff -u "$coverage" "$actual_coverage" >&2 || true
  exit 1
fi

expect_preflight_failure mismatched-types.itf.json MIC-C-EVIDENCE-001 mismatched-types
expect_preflight_failure missing-observation.itf.json MIC-P-TRACE-001 missing-observation
expect_preflight_failure unknown-action.itf.json MIC-P-ACTION-001 unknown-action
expect_preflight_failure wrong-kind-type.itf.json MIC-P-VALUE-001 wrong-kind-type

echo "DumpLedger model interface, exhaustive action coverage, and negative diagnostics are current"
