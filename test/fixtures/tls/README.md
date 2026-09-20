# Local test certificate

These PEM files are public test fixtures, including the deliberately disclosed
private key. Never use them in a deployment. Integration tests explicitly trust
this certificate only for their loopback HTTPS client; they also verify that a
client without that trust rejects the listener.

Regenerate before expiry with:

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout test/fixtures/tls/localhost-key.pem \
  -out test/fixtures/tls/localhost-cert.pem -days 3650 \
  -subj '/CN=DumpLedger test fixture only' \
  -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost'
```
