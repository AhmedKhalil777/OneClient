// Sets the GitHub repository's description, website and topics — what GitHub search and Google show first.
//   GITHUB_TOKEN=<token with "repo" scope> node scripts/github-metadata.mjs          (dry run: prints what it would send)
//   GITHUB_TOKEN=<token> node scripts/github-metadata.mjs --apply                    (does it)
// Not in CI on purpose: it edits the public repository page, so run it yourself when the text changes.
const REPO = process.env.GITHUB_REPOSITORY ?? "AhmedKhalil777/OneClient";

const description =
  "One VS Code-style client for PostgreSQL, SQL Server, MySQL, Kafka, Redis, Docker & REST — Fast Aggregates, test-scenario pipelines, AI assistant, Git graph, plugin API. Free, open source, desktop & self-hosted web.";
const homepage = "https://ahmedkhalil777.github.io/OneClient/";
// Lower-case, hyphenated, at most 20 (GitHub's limit). These are what people search the GitHub topic pages for.
const topics = [
  "sql-client",
  "database-gui",
  "postgresql",
  "sql-server",
  "mysql",
  "kafka-ui",
  "redis-gui",
  "http-client",
  "postman-alternative",
  "docker",
  "azure-blob-storage",
  "keycloak",
  "ai-assistant",
  "testcontainers",
  "vscode-like",
  "developer-tools",
  "plugin-system",
  "electron",
  "typescript",
  "database-client",
];

const apply = process.argv.includes("--apply");
console.log(`Repository: ${REPO}\nDescription (${description.length} chars): ${description}\nWebsite: ${homepage}\nTopics (${topics.length}): ${topics.join(", ")}\n`);
if (!apply) {
  console.log("Dry run. Re-run with --apply (and GITHUB_TOKEN) to update the repository.");
  process.exit(0);
}
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("Set GITHUB_TOKEN to a token that can edit this repository.");
  process.exit(1);
}

const api = async (method, path, body) => {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
};

// Discussions give questions a home other than Issues (the issue templates link to them); the wiki is unused.
await api("PATCH", "", { description, homepage, has_discussions: true, has_issues: true, has_wiki: false });
await api("PUT", "/topics", { names: topics });
console.log("Updated.");
