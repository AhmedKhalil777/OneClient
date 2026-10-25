import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Conversation, Msg } from "./types.js";

/** Conversations live at `~/.oneclient/ai/<connectionId>/<conversationId>.json` (or under `$ONECLIENT_HOME`). */
export function dataDir(): string {
  return join(process.env.ONECLIENT_HOME?.trim() || join(homedir(), ".oneclient"), "ai");
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function validId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

export function titleFrom(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 57)}…` : one || "New conversation";
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export class ConversationStore {
  /** Listing re-reads a file only when it changed: conversations carry long histories. */
  private readonly summaries = new Map<string, { mtime: number; summary: ConversationSummary | null }>();

  constructor(private readonly root: string = dataDir()) {}

  private dir(connectionId: string): string {
    if (!validId(connectionId)) throw new Error("Invalid connection id.");
    return join(this.root, connectionId);
  }

  private file(connectionId: string, id: string): string {
    if (!validId(id)) throw new Error("Invalid conversation id.");
    return join(this.dir(connectionId), `${id}.json`);
  }

  get(connectionId: string, id: string): Conversation | undefined {
    const file = this.file(connectionId, id);
    if (!existsSync(file)) return undefined;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Conversation;
      if (raw.version !== 1 || !Array.isArray(raw.messages)) return undefined;
      return raw;
    } catch {
      return undefined;
    }
  }

  /** A saved conversation, or a fresh empty one (not written until it has a message). */
  open(connectionId: string, id: string): Conversation {
    const now = new Date().toISOString();
    return this.get(connectionId, id) ?? { version: 1, id, title: "New conversation", createdAt: now, updatedAt: now, messages: [], usage: { input: 0, output: 0 } };
  }

  save(connectionId: string, conv: Conversation): void {
    mkdirSync(this.dir(connectionId), { recursive: true });
    const file = this.file(connectionId, conv.id);
    const tmp = `${file}.tmp`;
    conv.updatedAt = new Date().toISOString();
    writeFileSync(tmp, JSON.stringify(conv), "utf8");
    renameSync(tmp, file);
  }

  list(connectionId: string): ConversationSummary[] {
    const dir = this.dir(connectionId);
    if (!existsSync(dir)) return [];
    const out: ConversationSummary[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json") || !validId(name.slice(0, -5))) continue;
      const file = join(dir, name);
      let mtime = 0;
      try {
        mtime = statSync(file).mtimeMs;
      } catch {
        continue;
      }
      let entry = this.summaries.get(file);
      if (!entry || entry.mtime !== mtime) {
        const conv = this.get(connectionId, name.slice(0, -5));
        entry = { mtime, summary: conv && conv.messages.length ? { id: conv.id, title: conv.title, updatedAt: conv.updatedAt } : null };
        this.summaries.set(file, entry);
      }
      if (entry.summary) out.push(entry.summary);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  delete(connectionId: string, id: string): void {
    rmSync(this.file(connectionId, id), { force: true });
  }

  rename(connectionId: string, id: string, title: string): void {
    const conv = this.get(connectionId, id);
    if (!conv) return;
    conv.title = titleFrom(title);
    this.save(connectionId, conv);
  }
}

export const store = new ConversationStore();

/** A conversation as Markdown: what you asked, what it answered, and which tools it used. */
export function exportMarkdown(conv: Pick<Conversation, "title" | "messages" | "model" | "provider">): string {
  const lines = [`# ${conv.title}`, ""];
  if (conv.model) lines.push(`_Model: ${conv.provider ? `${conv.provider}/` : ""}${conv.model}_`, "");
  for (const item of transcript(conv.messages)) {
    lines.push(item.role === "user" ? "## You" : "## Assistant", "");
    for (const t of item.tools ?? []) lines.push(`- \`${t.name}\` ${String(t.input.path ?? t.input.pattern ?? t.input.sql ?? "").replace(/\s+/g, " ").slice(0, 120)}`.trimEnd());
    if (item.tools?.length) lines.push("");
    if (item.text) lines.push(item.text, "");
  }
  return lines.join("\n");
}

/** Messages as the chat view shows them: tool results are folded into the assistant message that made the call. */
export interface TranscriptItem {
  role: "user" | "assistant";
  text: string;
  tools?: Array<{ id: string; name: string; input: Record<string, unknown>; result?: string; isError?: boolean }>;
}

export function transcript(messages: readonly Msg[]): TranscriptItem[] {
  const out: TranscriptItem[] = [];
  const byCall = new Map<string, NonNullable<TranscriptItem["tools"]>[number]>();
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", text: m.text });
    else if (m.role === "assistant") {
      const tools = m.calls.map((c) => ({ id: c.id, name: c.name, input: c.input }));
      for (const t of tools) byCall.set(t.id, t);
      out.push({ role: "assistant", text: m.text, ...(tools.length ? { tools } : {}) });
    } else {
      for (const r of m.results) {
        const t = byCall.get(r.id);
        if (t) Object.assign(t, { result: r.content, isError: r.isError ?? false });
      }
    }
  }
  return out;
}
