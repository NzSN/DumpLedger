# Option 2 explained: rebuild the matching Mirrors compiler, then AI3

Decision aid written 2026-10-13 for the AI3 toolchain question. The user
selected option 1 (regenerate against the current compiler) on 2026-10-14;
this note remains as the record of the alternative.

## The situation

`pnpm test` runs `check:model-interface` (`tools/check-model-interface.sh`),
which invokes the external compiler
`/home/nzsn/Repos/Mirrors/.lake/build/bin/model_interface_gen` and requires
its output to be byte-identical to the committed generated bindings in
`src/generated/`.

It failed with `MIC-C-STALE-001 / generated output is stale` — not because
any model input changed, but because of toolchain drift:

| Fact | Evidence |
|---|---|
| Committed bindings date from | dump-ledger commit `2d40371`, 2026-09-17 14:11 +0800 |
| Compiler binary rebuilt | Oct 13, from a Mirrors checkout with unrelated dirty work at HEAD `66f9418` |
| Lock records only a coarse version | `compilerVersion: "model-interface-gen/1"` — no git revision, so matching is empirical |

## What option 2 meant

Restore the compiler that produced the committed bindings, verify the check
goes green without changing anything in dump-ledger, and only then start AI3.
AI3's Wave H would then regenerate against a known, pinned compiler, so its
diff contains exactly the `RecordAnalysis` interface change and nothing else.

## Why a git worktree, not a checkout

The Mirrors working copy has unrelated in-progress work. The check script
reads `MIRRORS_ROOT` (default `/home/nzsn/Repos/Mirrors`), so a scratch build
in a separate worktree can be pointed at it without touching the main
checkout.

## The procedure that was proposed

1. Pick the candidate revision: bindings committed Sep 17 14:11; Mirrors HEAD
   then was around `09379ae` (Sep 17 12:35).
2. Scratch build: `git -C /home/nzsn/Repos/Mirrors worktree add
   /tmp/mirrors-pin 09379ae`, then `lake build model_interface_gen` there.
3. Verify: `MIRRORS_ROOT=/tmp/mirrors-pin pnpm run check:model-interface`;
   green means matched, red means bisect the Sep 16–17 window.
4. Pin the matched revision in the repo for future builds.
5. Start AI3; Wave H regenerates with the pinned compiler.

## Trade-offs vs option 1 (regenerate against current compiler)

| | Option 2 (rebuild matching) | Option 1 (regenerate now) |
|---|---|---|
| dump-ledger diff before AI3 | none | large regenerated-artifact diff |
| Real changes vs noise | clean separation | drift mixed into the same diff |
| Compiler currency | pinned at the Sep revision | adopts current compiler state |
| Cost | one historical build + possible bisect | none now, more review noise |

Option 1 was chosen: the drift was absorbed as a clean baseline regen before
the `RecordAnalysis` spec change, keeping the AI3 interface diff honest.
