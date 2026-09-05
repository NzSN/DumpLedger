import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import type { TlsOptions } from "mirrorecma";

const execFileAsync = promisify(execFile);

export interface MbtPki {
  readonly directory: string;
  readonly caCertificate: string;
  readonly serverCertificate: string;
  readonly serverKey: string;
  readonly clientCertificate: string;
  readonly clientKey: string;
  readonly clientFingerprint: string;
}

async function openssl(directory: string, args: readonly string[]): Promise<void> {
  await execFileAsync("openssl", [...args], { cwd: directory });
}

export async function createMbtPki(): Promise<MbtPki> {
  const directory = await mkdtemp(resolve(tmpdir(), "dump-ledger-mbt-pki-"));
  const path = (name: string) => resolve(directory, name);
  try {
    await openssl(directory, [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", "ca.key", "-out", "ca.crt", "-days", "2",
      "-subj", "/CN=DumpLedger MBT Test CA",
    ]);
    await writeFile(path("server.ext"), [
      "subjectAltName=IP:127.0.0.1",
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=serverAuth",
      "",
    ].join("\n"));
    await openssl(directory, [
      "req", "-newkey", "rsa:2048", "-nodes",
      "-keyout", "server.key", "-out", "server.csr",
      "-subj", "/CN=127.0.0.1",
    ]);
    await openssl(directory, [
      "x509", "-req", "-in", "server.csr",
      "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
      "-out", "server.crt", "-days", "2", "-extfile", "server.ext",
    ]);
    await writeFile(path("client.ext"), [
      "basicConstraints=CA:FALSE",
      "keyUsage=digitalSignature,keyEncipherment",
      "extendedKeyUsage=clientAuth",
      "",
    ].join("\n"));
    await openssl(directory, [
      "req", "-newkey", "rsa:2048", "-nodes",
      "-keyout", "client.key", "-out", "client.csr",
      "-subj", "/CN=dump-ledger-mbt-client",
    ]);
    await openssl(directory, [
      "x509", "-req", "-in", "client.csr",
      "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial",
      "-out", "client.crt", "-days", "2", "-extfile", "client.ext",
    ]);
    for (const key of ["ca.key", "server.key", "client.key"]) {
      await chmod(path(key), 0o600);
    }
    const clientPem = await readFile(path("client.crt"), "utf8");
    return {
      directory,
      caCertificate: path("ca.crt"),
      serverCertificate: path("server.crt"),
      serverKey: path("server.key"),
      clientCertificate: path("client.crt"),
      clientKey: path("client.key"),
      clientFingerprint: createHash("sha256")
        .update(new X509Certificate(clientPem).raw)
        .digest("hex"),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function tlsOptions(pki: MbtPki): TlsOptions {
  return {
    caPath: pki.caCertificate,
    certPath: pki.clientCertificate,
    keyPath: pki.clientKey,
  };
}

export async function removeMbtPki(pki: MbtPki): Promise<void> {
  await rm(pki.directory, { recursive: true, force: true });
}
