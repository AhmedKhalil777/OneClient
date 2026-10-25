# oneclient-http — HTTP / REST API client for oneClient

An **HTTP and REST API client** (a Postman-style alternative) for [oneClient](../../../README.md), the VS Code-style client for SQL, Kafka, Redis, APIs and Docker.

- **Collections and folders** of requests, with **environments** and `{{variables}}`.
- **Params, headers, body and authentication**, response viewer, and request **history**.
- **Paste a request from the browser:** in dev tools (Network → right-click a request) choose **Copy as cURL (bash)**, **Copy as cURL (cmd)**, **Copy as PowerShell** or **Copy as fetch**, then paste into a request's URL box — the method, URL, headers, cookies, auth and body fill in. Hand-written `curl`, `Invoke-WebRequest` / `Invoke-RestMethod` (`iwr` / `irm`) and `fetch(...)` work too. PowerShell bodies that are variables or `ConvertTo-Json` expressions can't be evaluated; you are told when that happens.
- **Import** from Postman collections (and environments), or paste the same commands into **Import / Export**; **export** collections back to Postman.
- Request settings per workspace: timeout, redirects, self-signed certificates for dev servers.

## Run `.http` / `.rest` files

Open a `.http` or `.rest` file from the Explorer and every request gets a **▶ Send Request** button in the gutter (or press
**Ctrl+Alt+R** in a request, or use the toolbar's run button). The response opens beside the file: status, time, size,
colored JSON, images, headers, and what was actually sent. The format is the one used by VS Code's REST Client and
JetBrains' HTTP Client:

```http
@host = https://api.example.com

### Log in
# @name login
POST {{host}}/login
Content-Type: application/json

{ "user": "ann", "password": "secret" }

### Who am I
GET {{host}}/me
Authorization: Bearer {{login.response.body.$.token}}
```

- `###` separates requests; a bare URL means GET; `?a=b` / `&c=d` lines continue the URL.
- **Variables:** `@name = value` at the top, `{{name}}`, and dynamic values `{{$guid}}`, `{{$randomInt 1 100}}`,
  `{{$timestamp}}`, `{{$datetime iso8601}}`, `{{$processEnv NAME}}`.
- **Chaining:** `# @name login` then `{{login.response.body.$.token}}` (a JSONPath) or `{{login.response.headers.X-Id}}`.
  A request that uses another's response sends that one first if it hasn't run yet.
- `# @no-redirect` and `# @insecure` (accept a self-signed certificate) above a request; `Authorization: Basic user:pass` is encoded for you.
- **Paste into a `.http` file:** select a copied command and run **Actions → Convert cURL / PowerShell / fetch to request** to turn it into a ▶-runnable request.
- Not supported yet: bodies from files (`< ./body.json`), multipart helpers and `.env` files.

Requests are logged to the app's Output panel with credentials masked.
