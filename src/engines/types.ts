import { type Target } from '../config.js';

export interface PageResult {
  url: string;
  finalUrl: string;
  /** HTTP status the target answered. */
  status: number;
  title: string | null;
  /** Page text: Markdown from the API, plain text from the local engine. */
  content: string;
  /** Values of the `extract` schema (fields mode). */
  data?: Record<string, unknown>;
}

export interface Engine {
  readonly name: string;
  fetchPage(target: Target): Promise<PageResult>;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
