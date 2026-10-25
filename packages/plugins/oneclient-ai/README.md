# oneclient-ai — AI assistant for oneClient

Chat with **Claude, OpenAI, Gemini, DeepSeek, Kimi, GLM, Grok, Mistral, Qwen, OpenRouter, Ollama or any OpenAI-compatible server** inside [oneClient](../../../README.md), using your own API key. The chat opens in the secondary side bar by default.

## Setup

Add one **AI Assistant** connection and paste the API keys of the providers you use (leave the others empty). Pick a model per conversation from the model table in the chat: prices are shown (approximate, $ per 1M tokens) and providers without a key are dimmed. Keys are stored encrypted. Claude can also use `ANTHROPIC_API_KEY` or an `ant auth login` profile.

## What it can do

- **Chat:** streamed replies, Markdown with tables and code, **Mermaid diagrams**, optional reasoning view, token and cost estimate, conversation list with search, rename, delete and export to Markdown.
- **Your folders:** list, read and search files in the folders open in the Explorer; every edit or write shows a diff and waits for your approval.
- **Your databases and other plugins:** `list_connections`, then each plugin's tools. The PostgreSQL, SQL Server and MySQL plugins offer `*_schema`, `*_query` (read-only) and `*_execute` (asks first).
- **Quick action:** the *New AI Chat* icon in the title bar.

## Letting your plugin work with the AI

List tools in your manifest under the `oneclient.aiTools` extension point; the assistant offers them to the model and runs them through `context.aiTools.call`. See `@oneclient/plugin-api` (`ai-tools.ts`). Tools that are not `readOnly` make the assistant ask the user first.

## Notes

- Model ids and base URLs in the provider table are best-effort and editable; "Test connection" lists the models each key can use.
- There is no shell tool, and the assistant cannot leave the open folders.
