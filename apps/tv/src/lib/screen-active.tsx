import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
} from "react";
import { BackHandler } from "react-native";

/**
 * Whether the screen a component lives in is the one on screen. The shell
 * keeps visited screens mounted (so scroll, focus and loaded pages survive
 * navigation) and only shows one; everything outside a screen layer counts as
 * active.
 */
const ScreenActiveContext = createContext(true);

export function ScreenActiveProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <ScreenActiveContext.Provider value={active}>
      {children}
    </ScreenActiveContext.Provider>
  );
}

export function useScreenActive(): boolean {
  return useContext(ScreenActiveContext);
}

/**
 * Query options for a component in a kept screen. It stays subscribed while
 * hidden, so the cache counts its data as in use and doesn't collect it (a
 * screen left for longer than gcTime would otherwise come back empty), but it
 * doesn't re-render then. Pair with `useRefetchStaleOnShow`.
 */
export function useKeptQueryOptions(): {
  notifyOnChangeProps: [] | undefined;
} {
  const active = useScreenActive();
  return { notifyOnChangeProps: active ? undefined : [] };
}

/**
 * Refetches a query that went stale while its screen was hidden, once the
 * screen is shown again: what re-subscribing on show used to do.
 */
export function useRefetchStaleOnShow(query: {
  isStale: boolean;
  refetch: () => unknown;
}): void {
  const active = useScreenActive();
  const wasActive = useRef(active);
  const queryRef = useRef(query);
  queryRef.current = query;
  useEffect(() => {
    if (active && !wasActive.current && queryRef.current.isStale) {
      void queryRef.current.refetch();
    }
    wasActive.current = active;
  }, [active]);
}

/**
 * A hardwareBackPress handler that only exists while its screen is shown. A
 * hidden screen must never consume Back: React Native asks the newest handler
 * first, so a background screen's "close my submenu" would otherwise swallow
 * the press meant for whatever is in front. Registering on show also makes it
 * newer than the shell's, so it still runs first while the screen is up.
 */
export function useActiveBackHandler(handler: () => boolean): void {
  const active = useScreenActive();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!active) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () =>
      handlerRef.current(),
    );
    return () => sub.remove();
  }, [active]);
}
