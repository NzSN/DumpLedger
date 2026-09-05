import { emitKeypressEvents } from "node:readline";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { hashOperatorPassword } from "../src/auth/sessions.js";

interface Keypress {
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly name?: string;
}

function hiddenLine(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  return new Promise((resolveLine, reject) => {
    let value = "";
    const finish = (result: { readonly value?: string; readonly error?: Error }): void => {
      process.stdin.removeListener("keypress", onKeypress);
      process.stderr.write("\n");
      if (result.error !== undefined) reject(result.error);
      else resolveLine(result.value ?? "");
    };
    const onKeypress = (text: string | undefined, key: Keypress): void => {
      if (key.ctrl === true && (key.name === "c" || key.name === "d")) {
        finish({ error: new Error("password generation cancelled") });
      } else if (key.name === "return" || key.name === "enter") {
        finish({ value });
      } else if (key.name === "backspace") {
        value = Array.from(value).slice(0, -1).join("");
      } else if (text !== undefined && key.ctrl !== true && key.meta !== true && key.name !== "escape") {
        value += text;
      }
    };
    process.stdin.on("keypress", onKeypress);
  });
}

async function interactivePassword(): Promise<string> {
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    const password = await hiddenLine("Operator password (input hidden): ");
    const confirmation = await hiddenLine("Confirm operator password: ");
    if (password !== confirmation) throw new Error("operator passwords do not match");
    return password;
  } finally {
    process.stdin.setRawMode(wasRaw);
    process.stdin.pause();
  }
}

async function pipedPassword(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  const input = Buffer.concat(chunks).toString("utf8");
  const password = input.endsWith("\r\n") ? input.slice(0, -2) : input.endsWith("\n") ? input.slice(0, -1) : input;
  if (password.includes("\n") || password.includes("\r")) {
    throw new Error("piped password must contain exactly one line");
  }
  return password;
}

async function main(): Promise<void> {
  const interactive = process.stdin.isTTY && process.stderr.isTTY && typeof process.stdin.setRawMode === "function";
  const password = interactive ? await interactivePassword() : await pipedPassword();
  process.stdout.write(`${await hashOperatorPassword(password)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch(error => {
    process.stderr.write(`Failed to generate operator password hash: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
