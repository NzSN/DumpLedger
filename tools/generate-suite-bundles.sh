#!/bin/sh
# Maintainer action: regenerate the checked suite bundles (docs:
# Mirrors application-integration-guide). Run after spec/contract changes,
# alongside model-interface lock+trace regeneration.
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compiler=${MODEL_INTERFACE_GEN:-/home/nzsn/Repos/Mirrors/.lake/build/bin/model_interface_gen}

for pair in "DumpLedger:dump-ledger-suite" "DumpLedgerTransfer:dump-ledger-transfer-suite"; do
  module=${pair%%:*}
  out=${pair##*:}
  "$compiler" bundle \
    --lock "$repo_root/model-interface/$module.mirror-interface.lock.json" \
    --target mirrorecma-async-v1 \
    --out "$repo_root/src/generated/$out"
done

echo "suite bundles regenerated (src/generated/dump-ledger-suite, src/generated/dump-ledger-transfer-suite)"
