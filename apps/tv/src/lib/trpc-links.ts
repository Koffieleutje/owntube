import type { TRPCLink } from "@trpc/client";
import { httpBatchLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import type { AppRouter } from "@web/server/trpc/root";
import superjson from "superjson";
import { expireSession, getToken } from "@/lib/auth-token";
import { TRPC_URL } from "@/lib/config";

/** Sends the user back to sign-in when the server rejects the stored token. */
const sessionExpiryLink: TRPCLink<AppRouter> =
  () =>
  ({ next, op }) =>
    observable((observer) =>
      next(op).subscribe({
        next: (value) => observer.next(value),
        error: (err) => {
          if (err.data?.code === "UNAUTHORIZED") void expireSession();
          observer.error(err);
        },
        complete: () => observer.complete(),
      }),
    );

/** Shared by the vanilla and React Query clients so both behave the same. */
export function createLinks(): TRPCLink<AppRouter>[] {
  return [
    sessionExpiryLink,
    httpBatchLink({
      url: TRPC_URL,
      transformer: superjson,
      // Read on every request so a fresh login (or logout) takes effect without
      // rebuilding the client. The server falls back to this Bearer token when
      // there is no Auth.js cookie (createTRPCContext).
      headers: async () => {
        const token = await getToken();
        return token ? { authorization: `Bearer ${token}` } : {};
      },
    }),
  ];
}
