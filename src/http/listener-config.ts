import { isIP } from "node:net";

/** Only explicit addresses/networks are accepted, never boolean/all-hop trust.
 * The loopback default matches the supported local TLS proxy topology. */
export function trustedProxyAddresses(value = "127.0.0.1,::1"): readonly string[] {
  if (value.trim() === "") return [];
  const addresses = value.split(",").map(part => part.trim());
  for (const entry of addresses) {
    const [address, prefix, extra] = entry.split("/");
    const version = isIP(address ?? "");
    if (version === 0 || extra !== undefined || (prefix !== undefined &&
      (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (version === 4 ? 32 : 128)))) {
      throw new Error("DUMP_LEDGER_TRUSTED_PROXIES must contain explicit IP addresses or nonzero CIDR prefixes");
    }
  }
  return addresses;
}

export interface SymbolsListenerConfig {
  readonly port: number;
  readonly host: string;
  readonly tls?: { readonly certFile: string; readonly keyFile: string };
}

/** Plain HTTP is confined to literal loopback addresses for a local debugger,
 * authenticated tunnel, or local TLS proxy. Network listeners require TLS;
 * DUMP_LEDGER_HTTPS is an operator-API assertion and cannot bypass this rule. */
export function symbolsListenerConfig(env: NodeJS.ProcessEnv): SymbolsListenerConfig | undefined {
  const rawPort = env.DUMP_LEDGER_SYMBOLS_PORT;
  if (rawPort === undefined || rawPort === "") return undefined;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DUMP_LEDGER_SYMBOLS_PORT must be an integer from 1 through 65535");
  }
  const host = env.DUMP_LEDGER_SYMBOLS_HOST ?? "127.0.0.1";
  const certFile = env.DUMP_LEDGER_SYMBOLS_TLS_CERT || undefined;
  const keyFile = env.DUMP_LEDGER_SYMBOLS_TLS_KEY || undefined;
  if ((certFile === undefined) !== (keyFile === undefined)) {
    throw new Error("DUMP_LEDGER_SYMBOLS_TLS_CERT and DUMP_LEDGER_SYMBOLS_TLS_KEY must be configured together");
  }
  if (certFile !== undefined && keyFile !== undefined) return { host, port, tls: { certFile, keyFile } };
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("non-loopback symbols listening requires DUMP_LEDGER_SYMBOLS_TLS_CERT and DUMP_LEDGER_SYMBOLS_TLS_KEY; use loopback behind a trusted TLS proxy or authenticated tunnel otherwise");
  }
  return { host, port };
}
