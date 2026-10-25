// Sets the GitHub repository's description, website and topics — what GitHub search and Google show first.
//   GITHUB_TOKEN=<token with "repo" scope> node scripts/github-metadata.mjs          (dry run: prints what it would send)
//   GITHUB_TOKEN=<token> node scripts/github-metadata.mjs --apply                    (does it)
// Not in CI on purpose: it edits the public repository page, so run it yourself when the text changes.
const REPO = process.env.GITHUB_REPOSITORY ?? "AhmedKhalil777/OneClient";

const description =
  "Free, open-source VS Code-style desktop & web client for PostgreSQL, SQL Server, MySQL, Kafka, Redis, Docker, REST APIs (Postman alternative), Azure Blob & Keycloak — with an AI assistant, Git graph and a plugin API.";
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
  "git-graph",
  "vscode-like",
  "developer-tools",
  "plugin-system",
  "electron",
  "typescript",
  "react",
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

await api("PATCH", "", { description, homepage });
await api("PUT", "/topics", { names: topics });
console.log("Updated.");
