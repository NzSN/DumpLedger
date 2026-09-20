import assert from "node:assert/strict";
import { test } from "node:test";
import { symbolsListenerConfig, trustedProxyAddresses } from "../../src/http/listener-config.js";

test("proxy defaults trust only loopback and explicit networks are validated", () => {
  assert.deepEqual(trustedProxyAddresses(), ["127.0.0.1", "::1"]);
  assert.deepEqual(trustedProxyAddresses(""), []);
  assert.deepEqual(trustedProxyAddresses("192.0.2.1, 2001:db8::/64"), ["192.0.2.1", "2001:db8::/64"]);
  for (const value of ["true", "*", "loopback", "0.0.0.0/0", "::/0", "127.0.0.1,", "1.2.3.4/33", "::1/129", "1.2.3.4/8/9"]) {
    assert.throws(() => trustedProxyAddresses(value));
  }
});

test("symbols listener defaults to disabled or loopback-only plaintext", () => {
  assert.equal(symbolsListenerConfig({}), undefined);
  assert.deepEqual(symbolsListenerConfig({ DUMP_LEDGER_SYMBOLS_PORT: "4082" }), { host: "127.0.0.1", port: 4082 });
  assert.deepEqual(symbolsListenerConfig({ DUMP_LEDGER_SYMBOLS_PORT: "4082", DUMP_LEDGER_SYMBOLS_HOST: "::1" }), { host: "::1", port: 4082 });
  for (const host of ["0.0.0.0", "::", "192.0.2.1", "localhost", ""]) {
    assert.throws(() => symbolsListenerConfig({ DUMP_LEDGER_SYMBOLS_PORT: "4082", DUMP_LEDGER_SYMBOLS_HOST: host, DUMP_LEDGER_HTTPS: "true" }), /requires.*TLS/);
  }
});

test("network symbols listeners require both TLS files and a valid port", () => {
  const env = { DUMP_LEDGER_SYMBOLS_PORT: "4082", DUMP_LEDGER_SYMBOLS_HOST: "0.0.0.0", DUMP_LEDGER_SYMBOLS_TLS_CERT: "cert.pem", DUMP_LEDGER_SYMBOLS_TLS_KEY: "key.pem" };
  assert.deepEqual(symbolsListenerConfig(env), { host: "0.0.0.0", port: 4082, tls: { certFile: "cert.pem", keyFile: "key.pem" } });
  assert.throws(() => symbolsListenerConfig({ ...env, DUMP_LEDGER_SYMBOLS_TLS_KEY: "" }), /together/);
  assert.throws(() => symbolsListenerConfig({ ...env, DUMP_LEDGER_SYMBOLS_TLS_CERT: "" }), /together/);
  for (const port of ["0", "65536", "NaN", "4.5"]) assert.throws(() => symbolsListenerConfig({ ...env, DUMP_LEDGER_SYMBOLS_PORT: port }));
});
