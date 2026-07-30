import { isUpstreamDisabled } from "@/lib/upstream-base-url";
import {
  normalizePreferredUpstreamInstance,
  normalizeUpstreamInstanceList,
} from "@/lib/upstream-instances";
import { normalizeInvidiousOutboundBase } from "@/server/services/proxy/normalize";
import {
  orderUpstreamCandidates,
  type UpstreamHealthSnapshot,
  upstreamHealthSnapshot,
} from "@/server/services/upstream-health";

export type ProxySourceOverrides = {
  invidiousBaseUrl?: string | null;
  invidiousBaseUrls?: string[] | null;
  preferredInvidiousBaseUrl?: string | null;
};

export type UpstreamAvailability = {
  invidiousConfigured: boolean;
  anyConfigured: boolean;
};

export function describeUpstreamAvailability(
  overrides?: ProxySourceOverrides,
): UpstreamAvailability {
  const { invidiousBases } = resolveProxyBaseCandidates(overrides);
  return {
    invidiousConfigured: invidiousBases.length > 0,
    anyConfigured: invidiousBases.length > 0,
  };
}

/** Resolved Invidious base (env + per-user overrides). */
export function resolveEffectiveProxyBases(overrides?: ProxySourceOverrides): {
  invidiousBase: string;
} {
  return resolveProxyBases(overrides);
}

export type InstanceSourceRow = {
  /** Raw `INVIDIOUS_BASE_URL` value from the server environment. */
  envRaw: string | null;
  envUrl: string | null;
  envDisabled: boolean;
  /** Per-account URL saved in Settings (empty = not overriding). */
  profileOverride: string | null;
  /** URL OwnTube actually uses. */
  effectiveUrl: string | null;
  urls: string[];
  preferredUrl: string | null;
  health: UpstreamHealthSnapshot[];
};

export type InstanceSourceInfo = {
  invidious: InstanceSourceRow;
};

function readEnvInvidiousRaw(): string | null {
  const raw = process.env.INVIDIOUS_BASE_URL?.trim();
  return raw || null;
}

function readEnvInvidiousUrl(): string | null {
  return readEnvInvidiousUrls()[0] ?? null;
}

function splitConfiguredUrls(raw: string | null): string[] {
  if (!raw || isUpstreamDisabled(raw)) return [];
  return raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function readEnvInvidiousUrls(): string[] {
  return normalizeUpstreamInstanceList(
    splitConfiguredUrls(readEnvInvidiousRaw()),
  ).map(normalizeInvidiousOutboundBase);
}

/** Server env + optional profile overrides — for Settings display. */
export function getInstanceSourceInfo(profile?: {
  invidiousBaseUrl?: string;
  invidiousBaseUrls?: string[];
  preferredInvidiousBaseUrl?: string;
}): InstanceSourceInfo {
  const profileInvUrls = normalizeUpstreamInstanceList([
    ...(profile?.invidiousBaseUrls ?? []),
    ...(profile?.invidiousBaseUrl ? [profile.invidiousBaseUrl] : []),
  ]).map(normalizeInvidiousOutboundBase);
  const overrides =
    profileInvUrls.length > 0
      ? {
          invidiousBaseUrls: profileInvUrls,
          preferredInvidiousBaseUrl: profile?.preferredInvidiousBaseUrl,
        }
      : undefined;
  const { invidiousBases, preferredInvidiousBase } =
    resolveProxyBaseCandidates(overrides);

  const invEnvRaw = readEnvInvidiousRaw();

  return {
    invidious: {
      envRaw: invEnvRaw,
      envUrl:
        invEnvRaw && !isUpstreamDisabled(invEnvRaw)
          ? readEnvInvidiousUrl()
          : null,
      envDisabled: Boolean(invEnvRaw && isUpstreamDisabled(invEnvRaw)),
      profileOverride:
        profileInvUrls.length > 0 ? profileInvUrls.join(", ") : null,
      effectiveUrl: invidiousBases[0] ?? null,
      urls: invidiousBases,
      preferredUrl: preferredInvidiousBase ?? null,
      health: invidiousBases.map((url) =>
        upstreamHealthSnapshot("invidious", url),
      ),
    },
  };
}

export function resolveProxyBaseCandidates(overrides?: ProxySourceOverrides): {
  invidiousBases: string[];
  preferredInvidiousBase?: string;
} {
  const rawInvidious =
    overrides?.invidiousBaseUrls && overrides.invidiousBaseUrls.length > 0
      ? overrides.invidiousBaseUrls
      : overrides?.invidiousBaseUrl !== undefined
        ? [overrides.invidiousBaseUrl ?? ""]
        : readEnvInvidiousUrls();

  const invidiousBases = normalizeUpstreamInstanceList(rawInvidious).map(
    normalizeInvidiousOutboundBase,
  );
  const preferredInvidiousBase = normalizePreferredUpstreamInstance(
    overrides?.preferredInvidiousBaseUrl ?? undefined,
    invidiousBases,
  );

  return {
    invidiousBases: orderUpstreamCandidates(
      "invidious",
      invidiousBases,
      preferredInvidiousBase,
    ),
    preferredInvidiousBase,
  };
}

export function resolveProxyBases(overrides?: ProxySourceOverrides): {
  invidiousBase: string;
} {
  const { invidiousBases } = resolveProxyBaseCandidates(overrides);
  return { invidiousBase: invidiousBases[0] ?? "" };
}
