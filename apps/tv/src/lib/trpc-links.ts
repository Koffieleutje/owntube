import type { TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { AppRouter } from "@web/server/trpc/root";
import { signalSessionExpired } from "@/lib/session";

/**
 * Turns an UNAUTHORIZED from any procedure into a return to the login screen.
 *
 * A link rather than an HTTP-status check: `httpBatchLink` sends several
 * procedures in one request, and tRPC answers a mixed batch with 207, not 401
 * (`getBatchStatusCode` — one status only when every result agrees). A link
 * sees the typed error per operation, so a single expired-token failure among
 * successful calls still counts.
 */
export const sessionExpiryLink: TRPCLink<AppRouter> =
  () =>
  ({ op, next }) =>
    observable((observer) =>
      next(op).subscribe({
        next: (value) => observer.next(value),
        error: (err) => {
          if (err.data?.code === "UNAUTHORIZED") void signalSessionExpired();
          observer.error(err);
        },
        complete: () => observer.complete(),
      }),
    );
