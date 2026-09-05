import type { State, Value } from "mirrorecma";

const integer = (value: bigint): Value => ({ tag: "int", val: value });
const string = (value: string): Value => ({ tag: "str", val: value });

export function stepPayload(
  token: bigint,
  dump: bigint,
  kind = "unclassified",
): State {
  return {
    parameters: {
      tag: "record",
      val: {
        token: integer(token),
        dump: integer(dump),
        kind: string(kind),
      },
    },
  };
}

export function initialPayload(): State {
  return stepPayload(0n, 0n);
}
