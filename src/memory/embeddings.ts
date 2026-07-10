/**
 * Text embeddings via an OpenAI-compatible `/embeddings` endpoint.
 *
 * Configured entirely by env so the base app boots with none of it set:
 *   EMBEDDINGS_BASE_URL  e.g. https://api.openai.com/v1
 *   EMBEDDINGS_API_KEY   bearer secret for the endpoint
 *   EMBEDDINGS_MODEL     default 'text-embedding-3-small' (1536 dims)
 *
 * When the base URL or API key is missing — or the request fails for any reason —
 * `embed()` returns null so the caller (memory/store.ts) can fall back to keyword
 * search. Nothing here ever throws.
 */
import { logger } from '../logger.js';

const DEFAULT_MODEL = 'text-embedding-3-small';

/** True when both an endpoint and a key are present. */
export function embeddingsConfigured(): boolean {
  return Boolean(process.env.EMBEDDINGS_BASE_URL && process.env.EMBEDDINGS_API_KEY);
}

interface EmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

/**
 * Embed a single string into a dense vector, or null when embeddings are not
 * configured / the request fails. The 1536-dim default matches the pgvector
 * `memories.embedding` column in src/db/schema.ts.
 */
export async function embed(text: string): Promise<number[] | null> {
  const baseUrl = process.env.EMBEDDINGS_BASE_URL;
  const apiKey = process.env.EMBEDDINGS_API_KEY;
  const model = process.env.EMBEDDINGS_MODEL || DEFAULT_MODEL;
  if (!baseUrl || !apiKey) return null;

  const input = text.trim();
  if (!input) return null;

  const url = `${baseUrl.replace(/\/+$/, '')}/embeddings`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn({ status: res.status, body: body.slice(0, 500) }, 'embeddings request failed');
      return null;
    }
    const json = (await res.json()) as EmbeddingResponse;
    const vec = json.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      logger.warn('embeddings response contained no vector');
      return null;
    }
    return vec;
  } catch (err) {
    logger.warn(err, 'embeddings request threw');
    return null;
  }
}
