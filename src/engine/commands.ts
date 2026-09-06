import type { CaseId, CustomerId, DumpId, GrantId } from "../domain/ids.js";
export type LifecycleCommand =
  | { readonly type: "CreateCustomer"; readonly displayName: string }
  | { readonly type: "CreateCase"; readonly customerId: CustomerId; readonly title: string }
  | { readonly type: "StartInvestigation"; readonly caseId: CaseId }
  | { readonly type: "WaitForCustomer"; readonly caseId: CaseId }
  | { readonly type: "ResumeInvestigation"; readonly caseId: CaseId }
  | { readonly type: "ResolveCase"; readonly caseId: CaseId }
  | { readonly type: "CloseCase"; readonly caseId: CaseId }
  | { readonly type: "IssueGrant"; readonly caseId: CaseId; readonly expiresAt: string; readonly maxBytes: bigint }
  | { readonly type: "RevokeGrant"; readonly grantId: GrantId }
  | { readonly type: "ExpireGrant"; readonly grantId: GrantId }
  | { readonly type: "BeginUpload"; readonly grantSecret: string; readonly originalName: string }
  | { readonly type: "SealUpload"; readonly dumpId: DumpId; readonly byteSize: bigint; readonly sha256: string }
  | { readonly type: "FailUpload"; readonly dumpId: DumpId }
  | { readonly type: "PromoteObject"; readonly dumpId: DumpId }
  | { readonly type: "MarkQuarantined"; readonly dumpId: DumpId }
  | { readonly type: "AcceptDump"; readonly dumpId: DumpId }
  | { readonly type: "RejectDump"; readonly dumpId: DumpId }
  | { readonly type: "AuthorizeDownload"; readonly dumpId: DumpId }
  | { readonly type: "SetRetention"; readonly dumpId: DumpId; readonly purgeAt: string }
  | { readonly type: "BeginPurge"; readonly dumpId: DumpId }
  | { readonly type: "FinishPurge"; readonly dumpId: DumpId };
export type LifecycleAction = LifecycleCommand["type"];
