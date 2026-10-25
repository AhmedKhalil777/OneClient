import { useEffect, useRef, useState } from "react";
import {
  FILE_EDITORS_POINT,
  type DocumentSymbol,
  type FileEditorError,
  type FileEditorFeatures,
  type FileLens,
  type LensesResult,
  type SymbolsResult,
  type TokenClass,
  type TokensResult,
  matchFileEditors,
} from "@oneclient/plugin-api";
import { sanitizeContributions } from "./contributions.js";

/** Beyond this the document is too big to analyse on every pause in typing; features switch off. */
export const FEATURE_TEXT_LIMIT = 500_000;
const DEBOUNCE_MS = 180;

/**
 * Calls a feature command contributed by another plugin (format, symbols, …). Never throws: a plugin that
 * is disabled, crashed or slow just means that feature is unavailable, not that the editor breaks.
 */
export async function callFeature<T extends { ok: boolean }>(command: string, request: unknown): Promise<T | { ok: false; error: FileEditorError }> {
  try {
    return (await window.oneclientView.invokeCommand(command, [request])) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Electron prefixes errors that crossed IPC: "Error invoking remote method '…': Error: <the real message>".
    return { ok: false, error: { message: message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "") } };
  }
}

/**
 * What other plugins contributed for this file (`oneclient.editors`): format, breadcrumbs,
 * highlighting, preview, actions. `null` until the contributions have loaded.
 */
export function useFileFeatures(fileName: string): FileEditorFeatures | null {
  const [features, setFeatures] = useState<FileEditorFeatures | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.oneclientView
      .getContributions(FILE_EDITORS_POINT)
      .catch(() => [])
      .then((list) => {
        if (!cancelled) setFeatures(matchFileEditors(sanitizeContributions(list), fileName));
      });
    return () => {
      cancelled = true;
    };
  }, [fileName]);
  return features;
}

/** The runnable places of the document (`lenses` command), refreshed shortly after typing stops. */
export function useLenses(text: string, command: string | undefined, fileName: string, enabled: boolean): readonly FileLens[] {
  const [lenses, setLenses] = useState<readonly FileLens[]>([]);
  const request = useRef(0);
  useEffect(() => {
    if (!command || !enabled) {
      setLenses([]);
      return;
    }
    const id = ++request.current;
    const timer = setTimeout(async () => {
      const r = await callFeature<LensesResult>(command, { text, fileName });
      if (id === request.current && r.ok && "lenses" in r) setLenses(r.lenses);
    }, lenses.length ? DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
    // `lenses` is read only to skip the debounce on the first request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, command, fileName, enabled]);
  return lenses;
}

export interface TokenSnapshot {
  /** The text the tokens were computed for — the editor shifts them across later edits. */
  text: string;
  tokens: readonly number[];
  classes: readonly TokenClass[];
}
export interface SymbolSnapshot {
  text: string;
  symbols: readonly DocumentSymbol[];
  error?: FileEditorError | undefined;
}

/**
 * Keeps highlighting tokens and document symbols current. Both are requested a short moment after the
 * user stops typing (immediately the first time), computed in the contributing plugins, and
 * delivered as snapshots tied to the text they describe; stale replies are dropped.
 */
export function useAnalysis(text: string, features: FileEditorFeatures | null, fileName: string, enabled: boolean) {
  const [tokens, setTokens] = useState<TokenSnapshot | null>(null);
  const [symbols, setSymbols] = useState<SymbolSnapshot | null>(null);
  const tokensRequest = useRef(0);
  const symbolsRequest = useRef(0);

  const tokenCommand = enabled ? features?.tokens : undefined;
  const symbolCommand = enabled ? features?.symbols : undefined;

  useEffect(() => {
    if (!tokenCommand) {
      setTokens(null);
      return;
    }
    const id = ++tokensRequest.current;
    const timer = setTimeout(async () => {
      const r = await callFeature<TokensResult>(tokenCommand, { text, fileName });
      if (id === tokensRequest.current && r.ok && "tokens" in r) setTokens({ text, tokens: r.tokens, classes: r.classes });
    }, tokens ? DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
    // `tokens` is read only to skip the debounce on the very first request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, tokenCommand, fileName]);

  useEffect(() => {
    if (!symbolCommand) {
      setSymbols(null);
      return;
    }
    const id = ++symbolsRequest.current;
    const timer = setTimeout(async () => {
      const r = await callFeature<SymbolsResult>(symbolCommand, { text, fileName });
      if (id !== symbolsRequest.current) return;
      if (r.ok && "symbols" in r) setSymbols({ text, symbols: r.symbols, error: r.error });
    }, symbols ? DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, symbolCommand, fileName]);

  return { tokens, symbols };
}
