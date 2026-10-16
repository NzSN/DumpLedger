# Rich report delivery v2

Status: implemented contract and storage; live Windows qualification and deployment are separate release steps.

DumpAnalyzer remains the external debugger/assessment executor. DumpLedger stores an immutable canonical report alongside its compact v1-compatible analysis row. It does not execute debugger commands or convert model prose into verified causes.

## Publish and read

Authenticate using the existing analyzer bearer token, or an operator session (mutation CSRF rules apply). `GET /api/v2/capabilities` returns `richReports` with `schemaVersion: 2`, `maxReportBytes: 524288`, and `maxRequestBytes: 1048576`. An adapter without v2 support returns `richReports: null`; older servers may return 404.

`POST /api/v2/dumps/:dumpId/analyses` accepts all v1 request fields plus `reportJson` (the exact canonical UTF-8 JSON serialized as a string) and `reportDigest` (lowercase SHA-256 of those exact UTF-8 bytes). The 1 MiB request ceiling applies only to this route; v1 remains at 16 KiB, with 4 KiB facts. Full report JSON is capped at 512 KiB, with 128 stack frames, 64 module records, 32 evidence sections, and 8192 UTF-8 bytes per evidence excerpt. Addresses remain hexadecimal strings.

The canonical schema mirrors DumpAnalyzer `src/report.rs`. It requires provenance, exception, context, stack, symbols, rootCause, evidence, and completeness sections. The canonical identity must equal the route dump ID and compact analyzer/version/kind/input SHA. Its stable `r2_` ID is SHA-256 of the five identity strings (dumpId, inputSha256, kind, analyzerName, analyzerVersion), each prefixed by an eight-byte unsigned big-endian UTF-8 length.

The compact facts must preserve `schemaVersion: 2`, `reportId`, `reportDigest`, `exceptionCode`, `frameCount`, and `causeStatus`. Root-cause confirmation is rejected in this release. A confirmed immediate mechanism is accepted only when its instruction/register evidence, exact deterministic description, and citation set satisfy the narrow register-indirect MOV-read rule. This does not establish the origin of the faulting state.

```sh
# request.json contains compact attribution and the exact reportJson/digest.
curl --fail-with-body -H "Authorization: Bearer $ANALYZER_TOKEN" \
  -H 'Content-Type: application/json' --data-binary @request.json \
  "$LEDGER_URL/api/v2/dumps/$DUMP_ID/analyses"

curl --fail-with-body -H "Authorization: Bearer $ANALYZER_TOKEN" \
  "$LEDGER_URL/api/v2/dumps/$DUMP_ID/analyses/$ANALYSIS_ID"
```

A fresh write returns 201; exact replay returns 200 with the same `analysisId`. The response contains the compact metadata plus `reportJson` and `reportDigest`. The detail GET requires the same analyzer/session viewer authorization and returns 404 for absent detail. V1 lists retain compact rows and never embed full JSON.

## Retry, promotion, and purge

SQLite migration 9 adds `analysis_details` as an immutable child of the analysis ID. A new summary, full detail, and audit event commit in one transaction. If v1 fallback already stored a digest-bound v2 summary, a v2 request atomically attaches detail under the original analysis ID only when compact metadata and facts match. This creates one `AttachAnalysisDetail` audit effect. Equal detail is an idempotent replay; conflicting content or an unbound legacy summary returns `409 invalid_transition`. Invalid schema, hash, or report identity returns `400 invalid_request`.

Purge deletes compact rows and cascades canonical details in the same transaction. Backup includes the new table. The current v1 transfer format intentionally omits analysis reconstruction; export and import containing canonical details are therefore explicitly blocked before data could be silently dropped. Deployments must keep a database backup or transfer dump-only inventory before rich reports exist until a future transfer format preserves them.

## Qualification boundary

Focused contract, real SQLite, HTTP, and transfer tests cover mandatory sections, nested references, symbol identity mismatch, digest conflict, summary promotion, ACK-loss replay, rollback, and purge. Existing lifecycle MBT still observes whether analysis was recorded; canonical detail attachment, byte preservation, and cause validation are covered by these interface tests and are not claimed as established by the earlier Boolean model. Checked-in generated traces are unchanged.

Before deployment: take a SQLite backup, dry-run migration 9 on a copy, compare preexisting tables/counts and integrity checks, then restart and canary one explicitly selected dump. Rollback retains canonical data in the backup; do not run an older export/import against a rich database. No live deployment is implied by these source changes.
