// Typed fetch client generated from docs/api/openapi.yaml (#923).
// Regenerate the schema types with `npm run generate:api`; never edit api.d.ts by hand.
import createClient from "openapi-fetch";
import type { paths, components } from "./api";

export type Schemas = components["schemas"];

export const apiClient = createClient<paths>({ baseUrl: "" });

// Unwraps an openapi-fetch result, throwing on non-2xx so TanStack Query sees errors.
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (error !== undefined || data === undefined) throw new Error(`API ${response.status}: ${response.url}`);
  return data;
}
