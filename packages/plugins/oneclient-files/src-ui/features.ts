import { useEffect, useRef, useState } from "react";
import {
  FILE_EDITORS_POINT,
  type FileEditorError,
  type FileEditorFeatures,
  type DocumentSymbol,
  type SymbolsResult,
  type TokenClass,
  type TokensResult,
  matchFileEditors,
} from "@oneclient/plugin-api";
import { callFeature } from "./api.js";
import { sanitizeContributions } from "./lib/contributions.js";

/** Beyond this the document is too big to analyse on every pause in typing; features switch off. */
export const FEATURE_TEXT_LIMIT = 500_000;
const DEBOUNCE_MS = 180;

/**
 * What other plugins contributed for this file (`oneclient-files.editors`): format, breadcrumbs,
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
