import { isUpstreamDisabled } from "@/lib/upstream-base-url";
import { normalizeUpstreamInstanceList } from "@/lib/upstream-instances";
import { normalizeInvidiousOutboundBase } from "@/server/services/proxy/normalize";
import {
  orderUpstreamCandidates,
  type UpstreamHealthSnapshot,
  upstreamHealthSnapshot,
} from "@/server/services/upstream-health";

export type UpstreamAvailability = {
  invidiousConfigured: boolean;
  anyConfigured: boolean;
};

export function describeUpstreamAvailability(): UpstreamAvailability {
  const { invidiousBases } = resolveProxyBaseCandidates();
  return {
    invidiousConfigured: invidiousBases.length > 0,
    anyConfigured: invidiousBases.length > 0,
  };
}

/** Resolved Invidious base. */
export function resolveEffectiveProxyBases(): { invidiousBase: string } {
  return resolveProxyBases();
}

export type InstanceSourceRow = {
  /** Raw `INVIDIOUS_BASE_URL` value from the server environment. */
  envRaw: string | null;
  envUrl: string | null;
  envDisabled: boolean;
  /** URL OwnTube actually uses. */
  effectiveUrl: string | null;
  urls: string[];
  health: UpstreamHealthSnapshot[];
};

export type InstanceSourceInfo = {
  invidious: InstanceSourceRow;
};

function readEnvInvidiousRaw(): string | null {
  const raw = process.env.INVIDIOUS_BASE_URL?.trim();
  return raw || null;
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

/**
 * The configured upstream, for Settings display. There are no per-account
 * overrides: `INVIDIOUS_BASE_URL` in the server environment is the only source
 * (it may list several instances, whitespace/comma separated).
 */
export function getInstanceSourceInfo(): InstanceSourceInfo {
  const { invidiousBases } = resolveProxyBaseCandidates();
  const invEnvRaw = readEnvInvidiousRaw();
  const configured = invEnvRaw && !isUpstreamDisabled(invEnvRaw);
  return {
    invidious: {
      envRaw: invEnvRaw,
      envUrl: configured ? (readEnvInvidiousUrls()[0] ?? null) : null,
      envDisabled: Boolean(invEnvRaw && isUpstreamDisabled(invEnvRaw)),
      effectiveUrl: invidiousBases[0] ?? null,
      urls: invidiousBases,
      health: invidiousBases.map((url) =>
        upstreamHealthSnapshot("invidious", url),
      ),
    },
  };
}

export function resolveProxyBaseCandidates(): { invidiousBases: string[] } {
  return {
    invidiousBases: orderUpstreamCandidates(
      "invidious",
      readEnvInvidiousUrls(),
    ),
  };
}

export function resolveProxyBases(): { invidiousBase: string } {
  const { invidiousBases } = resolveProxyBaseCandidates();
  return { invidiousBase: invidiousBases[0] ?? "" };
}
