import type { NetworkAccess } from "../../../../core/contracts/network.js";
import { declaredErrorCode } from "../../../../core/errors/classify.js";
import { fetchNetworkResponse } from "../../../network/retry.js";
import { withSourceFallbacks } from "../../../network/source-fallback.js";
import { datasetActivity } from "../../activity.js";
import type { DatasetCache } from "../../cache.js";
import { HUGGING_FACE_OFFICIAL_ORIGIN, huggingFaceFallbackUrls } from "./origins.js";

export type HuggingFaceTransport = { apiBase: string; fileBase: string; publicMirror?: string };

/** Hub origin. `HF_ENDPOINT=https://hf-mirror.com` replaces huggingface.co for API and file URLs. */
export function huggingfaceEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.HF_ENDPOINT?.trim();
  if (!raw) return HUGGING_FACE_OFFICIAL_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TypeError("HF_ENDPOINT must be an http(s) origin");
  }
  const hasPath = url.pathname !== "/" && url.pathname !== "";
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.search || url.hash || hasPath) {
    throw new TypeError("HF_ENDPOINT must be an http(s) origin");
  }
  return url.origin;
}

export function huggingfaceTransport(env: NodeJS.ProcessEnv = process.env, network?: NetworkAccess): HuggingFaceTransport {
  const sources = network?.settings.sources;
  const endpoint = sources?.huggingface ?? huggingfaceEndpoint(env);
  return { apiBase: endpoint, fileBase: endpoint, ...(sources?.huggingfacePublicMirror ? { publicMirror: endpoint } : {}) };
}

export function fetchHuggingFaceMetadata(url: string, transport: HuggingFaceTransport, signal: AbortSignal,
  headers?: Record<string, string>, network?: NetworkAccess): Promise<Response> {
  const matchesOrigin = url.startsWith(transport.apiBase + "/");
  const fallbacks = matchesOrigin ? huggingFaceFallbackUrls(url, transport.publicMirror) : [];
  return withSourceFallbacks(url, fallbacks, async target => {
    const response = await fetchNetworkResponse(target, {
      signal, ...(headers && matchesOrigin && target === url ? { headers } : {}),
    }, network ? { network } : {});
    if (!response.ok && target !== url) throw new Error(`Hugging Face fallback metadata HTTP ${response.status}`);
    return response;
  }, {
    signal,
    shouldFallback: error => declaredErrorCode(error) === "NETWORK_FAILURE",
    onFallback: (source, fallback) => datasetActivity(`Hugging Face mirror ${new URL(source).hostname} unavailable; trying ${new URL(fallback).hostname}`),
  });
}

export function fetchHuggingFaceFile(cache: DatasetCache, url: string, transport: HuggingFaceTransport, digest: string | null,
  signal: AbortSignal, headers?: Record<string, string>) {
  const matchesOrigin = url.startsWith(transport.fileBase + "/");
  const fallbacks = matchesOrigin ? huggingFaceFallbackUrls(url, transport.publicMirror) : [];
  return cache.fetch(url, digest, signal, matchesOrigin ? headers : undefined, fallbacks);
}
