# Launch kit

A checklist and ready-to-edit copy for getting oneClient in front of the developers who'd use it. Stars follow usefulness and
visibility, in that order: the product, the README and the website are the part that converts; this file is the part that gets people
to look. Edit the copy so it sounds like you.

> **Play it straight.** Don't ask friends to mass-star or upvote, don't trade stars, and don't buy them. GitHub, Hacker News and Reddit
> all detect it and it gets projects flagged. Ask people who'd genuinely use it, say you're the author, and answer every comment.

## 1. Before you post anything (one hour)

| Do this | How |
| --- | --- |
| Add the **social preview** image | Repo → *Settings* → *Social preview* → upload `docs/images/social-preview.png` (source: `docs/social-preview.html`) |
| Set description, website and **topics** | `GITHUB_TOKEN=<token> node scripts/github-metadata.mjs --apply` (dry-run without `--apply`) |
| Turn on **Discussions** | Done by the script above (`has_discussions`), or *Settings → Features* |
| Publish a **release** with the installers | Tag `v0.1.x`; the *Release* workflow builds them. Write notes from the template in §4 |
| Enable **GitHub Pages** | *Settings → Pages → Source: GitHub Actions*; the *Website* workflow deploys `site/` |
| Label a few **good first issues** | 5–8 small, well-described issues (docs, a missing icon, a plugin idea). Newcomers convert to contributors, and contributors to stars |
| **Pin** the README's must-reads | Pin one Discussion ("Roadmap & ideas") and the *good first issue* list |
| Check the first-run experience | On a clean machine: download → install → add a connection → open a Fast Aggregate. Fix every snag *before* the launch |

## 2. Assets (already in the repo)

- `docs/images/*.png` — screenshots of the workbench, SQL, Kafka, HTTP, Redis, Fast Aggregates and Pipelines.
- `docs/images/social-preview.png` — the 1280×640 link card.
- **A 20–30 second screen recording** is the one thing still missing, and it's the single highest-leverage asset: Fast Aggregates
  (right-click table → edit an order with its items → create a customer in the picker) and a pipeline running. Record at 1440×900, keep it
  under 10 MB, put it at the top of the README as a GIF or an `<video>` on a GitHub release.

## 3. Where to post, and in what order

Post on a **Tuesday–Thursday morning US Eastern**, one place at a time, and stay around for the first hours to answer.

1. **Show HN** — title, then a first comment from you (below). Link the repo, not the site.
2. **Reddit** — read each subreddit's self-promotion rules first; some need a flair or a ratio of other participation.
   Good fits: r/selfhosted (the Docker web version), r/PostgreSQL, r/SQLServer, r/apachekafka, r/redis, r/webdev, r/opensource.
   Tailor each post to that community's tool — don't paste the same text.
3. **X / Mastodon / Bluesky / LinkedIn** — a short thread with the Fast Aggregates and Pipelines screenshots.
4. **dev.to / Hashnode** — a longer post: *"I wanted one VS Code-style client for my whole backend stack, so I built it"* — what you built,
   one design decision (plugins in their own process), one thing that surprised you.
5. **Product Hunt** — optional; worth it only with a recording and a few people ready to try it that day.
6. **Awesome lists** — send a PR (following each list's rules) to lists where it fits, for example awesome-selfhost, awesome-electron,
   and the relevant database / Kafka / developer-tools lists. A one-line, honest description is enough.

## 4. Copy to adapt

### Show HN

> **Show HN: oneClient – a VS Code-style client for Postgres/SQL Server/MySQL, Kafka, Redis and REST**
>
> Hi HN, I'm the author. I kept switching between a database IDE, a Kafka tool, Redis GUI, an API client and Docker, so I built one
> window for all of them that looks and works like VS Code (command palette, split editors, terminal, Git graph). Every integration is
> a plugin that runs in its own process, so you can add your own.
>
> Two things I'm most curious about feedback on: **Fast Aggregates** (right-click a table and it builds an editable "Order → Items → Tags"
> screen from your foreign keys) and **Pipelines** (script → test container → seed → call your API → assert, with teardown).
>
> It's MIT, runs as a desktop app (Windows/macOS/Linux) or self-hosted in the browser, has no account and no telemetry, and the AI
> assistant is bring-your-own-key. Installers aren't signed yet. Repo: https://github.com/AhmedKhalil777/OneClient

First comment (post it right away): the stack, what's *not* done (unsigned installers, SQL Server/MySQL less battle-tested than
PostgreSQL), and a specific question for readers.

### Reddit (r/selfhosted flavour)

> **I built a self-hostable VS Code-style workbench for Postgres/MySQL/SQL Server, Kafka, Redis and REST (MIT)**
> One Docker container, one login token, everything in the browser — terminal and Git included. Plugins for each tool, no telemetry.
> `docker build -t oneclient . && docker run -p 127.0.0.1:4180:4180 -v oneclient-data:/data oneclient`.
> Screenshots and a short list of what it does: <repo link>. Honest limits: single-user, put it behind HTTPS if you expose it. Feedback welcome.

### Short post (X / LinkedIn)

> Seven apps open to do one backend task? I built **oneClient**: one VS Code-style window for PostgreSQL, SQL Server, MySQL, Kafka, Redis,
> REST and Docker — free and open source.
> 🧩 plugins for everything · 🧱 Fast Aggregates: edit an Order with its Items in one screen · 🧪 Pipelines: scenarios with test containers
> ⭐ <repo link>

### Release notes template

```md
## oneClient v0.1.x

### Highlights
- **Fast Aggregates** — right-click a table to edit it with its related tables as one screen
- **Pipelines & test containers** — scripts, containers and API assertions as a scenario
- **Notifications** — toasts and a Notification Center when a task finishes or needs you

### Fixes
- …

### Downloads
Windows (.exe / .zip) · macOS (Apple silicon / Intel .dmg) · Linux (AppImage / .tar.gz). Installers aren't code-signed yet; SHA-256
checksums are listed below.
```

## 5. After the first day

- Answer every comment and issue within hours for the first week. Turn repeated questions into README / FAQ entries.
- Convert the best requests into `good first issue`s with a short "where to start" note.
- Thank contributors by name in the release notes.
- Look at where visitors come from (*Insights → Traffic*) and double down on the channel that worked.
- Ship something visible every one to two weeks — a release, a changelog line, a screenshot. Projects that look alive get starred.

## 6. What makes people star

They star what they might need later and trust enough to bookmark: a README that shows the product in ten seconds, installers that work
the first time, honest limits, and a maintainer who answers. Everything above serves those four.
