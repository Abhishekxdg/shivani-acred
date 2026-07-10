import OpenAI from 'openai';
import { config } from '../config.js';

/**
 * OpenRouter is OpenAI-API-compatible, so we drive it with the official OpenAI
 * SDK pointed at OpenRouter's base URL. The extra headers are OpenRouter's
 * attribution headers (optional but recommended).
 */
export const llm = new OpenAI({
  apiKey: config.OPENROUTER_API_KEY,
  baseURL: config.OPENROUTER_BASE_URL,
  defaultHeaders: {
    'HTTP-Referer': config.APP_URL,
    'X-Title': config.APP_TITLE,
  },
});

export const MODEL = config.OPENROUTER_MODEL;
