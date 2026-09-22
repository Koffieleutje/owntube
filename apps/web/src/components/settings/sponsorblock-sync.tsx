"use client";

import { useEffect } from "react";
import {
  sponsorBlockPrefsFromAppSettings,
  writeSponsorBlockPrefs,
} from "@/lib/sponsorblock-prefs";
import { trpc } from "@/trpc/react";

export function SponsorBlockSync() {
  // Logged-out visitors have no settings; don't fire a request that 401s.
  const authed = trpc.auth.session.useQuery().data?.authed ?? false;
  const { data } = trpc.settings.get.useQuery(undefined, {
    enabled: authed,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (!data) return;
    writeSponsorBlockPrefs(sponsorBlockPrefsFromAppSettings(data));
  }, [data]);

  return null;
}
