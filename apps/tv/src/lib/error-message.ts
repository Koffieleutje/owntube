/** Surfaces tRPC/upstream error messages (rate-limit, upstream-unavailable). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong.";
}
