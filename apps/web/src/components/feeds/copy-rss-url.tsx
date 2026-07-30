"use client";

import { useActionToast } from "@/components/videos/action-toast";
import { trpc } from "@/trpc/react";

export type RssFeedKind =
  | "playlist"
  | "queue"
  | "saved"
  | "subscriptions"
  | "tag"
  | "channel";

/**
 * Copy a feed's credentialed companion URL (audio variant) to the clipboard.
 * The URL comes from the slugs the publisher recorded on its last run, so a
 * brand-new or still-empty feed reports "not published yet" instead.
 */
export function useCopyRssUrl(): (
  kind: RssFeedKind,
  refId: string,
) => Promise<void> {
  const utils = trpc.useUtils();
  const { showToast } = useActionToast();
  return async (kind, refId) => {
    try {
      const res = await utils.settings.rssFeedUrl.fetch({ kind, refId });
      if (!res.url) {
        showToast(
          res.reason === "not-published"
            ? "Not published yet — feeds update every half hour"
            : "No feed server configured",
        );
        return;
      }
      await navigator.clipboard.writeText(res.url);
      showToast("RSS feed URL copied");
    } catch {
      showToast("Could not copy the RSS URL");
    }
  };
}

/** Header-style pill for pages that have no menu (e.g. Subscriptions). */
export function CopyRssUrlButton({
  kind,
  refId,
}: {
  kind: RssFeedKind;
  refId: string;
}) {
  const copyRssUrl = useCopyRssUrl();
  return (
    <button
      type="button"
      onClick={() => void copyRssUrl(kind, refId)}
      className="rounded-full border border-[hsl(var(--border))] px-4 py-1.5 text-sm font-medium text-[hsl(var(--muted-foreground))] transition hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]"
    >
      Copy RSS URL
    </button>
  );
}
