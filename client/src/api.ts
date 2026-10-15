import type { HealthResponse } from "@watch-together/shared";

export async function getHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/shit");

  if (!response.ok) {
    throw new Error(`Server returned HTTP ${response.status}`);
  }

  const body: HealthResponse = await response.json();
  return body;
}
