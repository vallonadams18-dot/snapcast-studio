Self-signed TLS pair for the real-transport test fixture ONLY.
SAN = DNS:webhook-fixture.test. Grants no trust anywhere: tests pass it as
an explicit `ca`, which REPLACES the trust store for that one connection.
Not a secret — it protects nothing and signs nothing outside the test.
