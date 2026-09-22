"use client";

import { useEffect } from "react";
import {
  writeWatchMiniEnabled,
  writeWatchMiniState,
} from "@/lib/watch-mini-player-state";
import { trpc } from "@/trpc/react";

export function MiniPlayerSync() {
  // Logged-out visitors have no settings; don't fire a request that 401s.
  const authed = trpc.auth.session.useQuery().data?.authed ?? false;
  const { data } = trpc.settings.get.useQuery(undefined, {
    enabled: authed,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!data) return;
    const enabled = data.enableMiniPlayer ?? true;
    writeWatchMiniEnabled(enabled);
    if (!enabled) writeWatchMiniState(null);
  }, [data]);

  return null;
}
