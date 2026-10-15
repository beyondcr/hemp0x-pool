# Security Policy

## Supported Versions

Security fixes are made against the current `main` branch. Operators should
run a tagged release or a reviewed commit and keep the Hemp0x daemon and host
system updated.

## Reporting a Vulnerability

Please do not open a public issue for an unpatched vulnerability. Contact the
Hemp0x maintainers privately with:

- A short description of the issue and its impact
- The affected version or commit
- Reproduction steps or a minimal proof of concept
- Any suggested mitigation

Do not include wallet files, RPC cookies, private keys, tokens, database files,
or other credentials in a report. Redact hostnames, addresses, and logs when
they are not required to reproduce the issue.

## Operational Security

- Run the pool and daemon under separate dedicated service accounts when practical.
- Keep the admin dashboard bound to localhost or protect it with a strong token.
- Use RPC cookie authentication instead of static RPC credentials.
- Keep `config.json`, wallet backups, databases, logs, and daemon data outside Git.
- Start with the example configuration's non-broadcasting safety gates and enable
  live payout or consolidation only after reviewing the wallet and recovery plan.
- Keep the daemon RPC bound to localhost or a private network. Do not expose the
  RPC port to the Internet.
- Keep the web service behind a TLS reverse proxy or firewall direct HTTP access.
  If remote admin access is enabled, use a high-entropy bearer token, HTTPS, and
  rate limiting at the proxy.
- The Stratum service applies connection, request-size, worker-retention, and
  concurrent-share-validation limits. Tune these limits for the host rather than
  disabling them to accommodate abusive clients.

## Runtime Hardening

The pool treats miner connections as untrusted input. Oversized or incomplete
Stratum requests are closed before they can grow process memory, and share
validation is bounded so one client cannot consume all daemon RPC capacity.
Disconnected worker identities are removed after the configured retention period.
Miner passwords are not written to logs.
