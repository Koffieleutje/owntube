import { createTRPCClient } from "@trpc/client";
// Type-only import: erased at build time, so Metro never bundles any server
// code. It gives the TV client the same end-to-end type safety as the web app.
import type { AppRouter } from "@web/server/trpc/root";
import { createLinks } from "@/lib/trpc-links";

export const trpcClient = createTRPCClient<AppRouter>({ links: createLinks() });
