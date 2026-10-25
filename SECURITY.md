# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for a security problem. Use GitHub's private reporting:
**[Report a vulnerability](https://github.com/AhmedKhalil777/OneClient/security/advisories/new)** (repository → *Security* →
*Advisories*). Include what you found, how to reproduce it, and the version. We'll acknowledge it, work on a fix and credit you if you
wish.

## Supported versions

Only the latest release receives security fixes while the project is on `0.x`.

## What to know about oneClient's trust model

- **Plugins are not sandboxed.** Each plugin runs in its own process, which contains crashes, but a plugin you install can do what any
  Node program can. Install plugins you trust. See [ARCHITECTURE.md](ARCHITECTURE.md).
- **Secrets.** Connection passwords are encrypted with the operating system's keychain on the desktop, and with a server-side key in the
  web version. Notifications and Output logs are kept in memory and must not contain secrets.
- **The web version** is for a single user. It listens on `127.0.0.1` by default and requires an access token; if you expose it, put it
  behind HTTPS and keep the token secret — anyone with the token gets your connections and a terminal.
- **The AI assistant** talks only to the provider you configure, with your key. Anything that changes data, and every file edit, waits
  for your approval; you can turn database and file access off per connection.
- **No telemetry.** oneClient doesn't phone home.
