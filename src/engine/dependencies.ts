import { randomBytes, randomUUID } from "node:crypto";
import { SimulatedCrash } from "../domain/errors.js";
import { parseGeneratedId, type AuditEventId, type CaseId, type CustomerId, type DumpId, type GrantId, type IdentifierKind, type IdSource } from "../domain/ids.js";

export interface Clock { now(): string }
export interface EntropySource { secret(): string }
export type DurableCheckpoint = "after_staging_create" | "after_vault_promote" | "after_vault_remove";
export interface FailpointPort { hit(checkpoint: DurableCheckpoint): void }

export class SystemClock implements Clock { now(): string { return new Date().toISOString(); } }
export class DeterministicClock implements Clock {
  constructor(private current: string) {}
  now(): string { return this.current; }
  set(value: string): void { this.current = value; }
}
export class CryptoEntropy implements EntropySource {
  secret(): string { return randomBytes(32).toString("base64url"); }
}
export class DeterministicEntropy implements EntropySource {
  constructor(private readonly values: string[]) {}
  secret(): string {
    const next = this.values.shift();
    if (next === undefined) throw new Error("deterministic entropy exhausted");
    return next;
  }
}

type AnyId = CustomerId | CaseId | GrantId | DumpId | AuditEventId;
export class RandomIds implements IdSource {
  next(kind: "customer"): CustomerId;
  next(kind: "case"): CaseId;
  next(kind: "grant"): GrantId;
  next(kind: "dump"): DumpId;
  next(kind: "audit"): AuditEventId;
  next(kind: IdentifierKind): AnyId {
    const body = randomUUID().replaceAll("-", "").slice(0, 26).toUpperCase();
    return parseGeneratedId(kind, `${kind}_${body}`) as AnyId;
  }
}
export class DeterministicIds implements IdSource {
  private sequence = 0;
  next(kind: "customer"): CustomerId;
  next(kind: "case"): CaseId;
  next(kind: "grant"): GrantId;
  next(kind: "dump"): DumpId;
  next(kind: "audit"): AuditEventId;
  next(kind: IdentifierKind): AnyId {
    this.sequence += 1;
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let remaining = this.sequence;
    let encoded = "";
    do {
      encoded = `${alphabet[remaining % 32]}${encoded}`;
      remaining = Math.floor(remaining / 32);
    } while (remaining > 0);
    return parseGeneratedId(kind, `${kind}_${encoded.padStart(26, "0")}`) as AnyId;
  }
}
export class NoFailpoints implements FailpointPort { hit(_checkpoint: DurableCheckpoint): void {} }
export class ScriptedFailpoints implements FailpointPort {
  private readonly pending: DurableCheckpoint[];
  constructor(checkpoints: readonly DurableCheckpoint[]) { this.pending = [...checkpoints]; }
  hit(checkpoint: DurableCheckpoint): void {
    if (this.pending[0] === checkpoint) {
      this.pending.shift();
      throw new SimulatedCrash(checkpoint);
    }
  }
}
