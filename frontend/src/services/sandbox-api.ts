import { SandboxFile } from "./webcontainer";

// ImportMetaEnv (including VITE_API_URL) is declared globally in src/env.d.ts.
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:3001";

export interface SavedSandbox {
  sandboxId: string;
  templateId: string;
  files: Record<string, SandboxFile>;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export async function saveSandbox(
  sandboxId: string,
  templateId: string,
  files: Map<string, SandboxFile>,
  metadata?: Record<string, any>,
): Promise<void> {
  const filesObj: Record<string, SandboxFile> = {};
  for (const [key, file] of files) {
    filesObj[key] = file;
  }

  const response = await fetch(`${API_BASE}/api/sandbox`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sandboxId,
      templateId,
      files: filesObj,
      metadata,
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to save sandbox: ${response.statusText}`);
  }
}

export async function loadSandbox(sandboxId: string): Promise<SavedSandbox> {
  const response = await fetch(`${API_BASE}/api/sandbox/${sandboxId}`);

  if (!response.ok) {
    throw new Error(`Failed to load sandbox: ${response.statusText}`);
  }

  return response.json();
}

export async function listSandboxes(
  limit: number = 20,
  offset: number = 0,
): Promise<{
  sandboxes: Omit<SavedSandbox, "files">[];
  total: number;
}> {
  const response = await fetch(`${API_BASE}/api/sandboxes?limit=${limit}&offset=${offset}`);

  if (!response.ok) {
    throw new Error(`Failed to list sandboxes: ${response.statusText}`);
  }

  return response.json();
}

export async function deleteSandbox(sandboxId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/api/sandbox/${sandboxId}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    throw new Error(`Failed to delete sandbox: ${response.statusText}`);
  }
}
