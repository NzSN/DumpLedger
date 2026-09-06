import type { State, Value } from "mirrorecma";

const integer = (value: bigint): Value => ({ tag: "int", val: value });
const string = (value: string): Value => ({ tag: "str", val: value });

function payload(record: Record<string, Value>): State {
  return { parameters: { tag: "record", val: record } };
}

export function stepPayload(
  token: bigint,
  dump: bigint,
  kind = "unclassified",
): State {
  return payload({
    case: integer(0n),
    token: integer(token),
    dump: integer(dump),
    kind: string(kind),
  });
}

export function casePayload(caseValue: bigint): State {
  return payload({
    case: integer(caseValue),
    token: integer(0n),
    dump: integer(0n),
    kind: string("unclassified"),
  });
}

export function initialPayload(): State {
  return stepPayload(0n, 0n);
}
