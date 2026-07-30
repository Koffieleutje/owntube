"use client";

import { useEffect, useRef, useState } from "react";
import { useActionToast } from "@/components/videos/action-toast";
import { trpc } from "@/trpc/react";

export type RssFeedKind =
  | "playlist"
  | "queue"
  | "saved"
  | "subscriptions"
  | "tag"
  | "channel";

export type RssFeedVariant = "audio" | "video";

/**
 * Copy a feed's credentialed companion URL to the clipboard, in the chosen
 * enclosure variant. The URL comes from the slugs the publisher recorded on
 * its last run, so a brand-new or still-empty feed reports "not published
 * yet" instead.
 */
export function useCopyRssUrl(): (
  kind: RssFeedKind,
  refId: string,
  variant: RssFeedVariant,
) => Promise<void> {
  const utils = trpc.useUtils();
  const { showToast } = useActionToast();
  return async (kind, refId, variant) => {
    try {
      const res = await utils.settings.rssFeedUrl.fetch({ kind, refId });
      const url = variant === "audio" ? res.audioUrl : res.videoUrl;
      if (!url) {
        showToast(
          res.reason === "not-published"
            ? "Not published yet — feeds update every half hour"
            : "No feed server configured",
        );
        return;
      }
      await navigator.clipboard.writeText(url);
      showToast(`RSS ${variant} feed URL copied`);
    } catch {
      showToast("Could not copy the RSS URL");
    }
  };
}

/**
 * "Copy RSS URL" with an audio/video chooser. Default styling suits page
 * headers on the standard background; pass buttonClassName to restyle the
 * trigger (e.g. the playlist header's white-on-brand pill).
 */
export function CopyRssUrlButton({
  kind,
  refId,
  buttonClassName,
}: {
  kind: RssFeedKind;
  refId: string;
  buttonClassName?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const copyRssUrl = useCopyRssUrl();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          buttonClassName ??
          "rounded-full border border-[hsl(var(--border))] px-4 py-1.5 text-sm font-medium text-[hsl(var(--muted-foreground))] transition hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]"
        }
      >
        Copy RSS URL
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-40 mt-1 w-40 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-1 text-sm shadow-lg"
        >
          {(["audio", "video"] as const).map((variant) => (
            <button
              key={variant}
              type="button"
              role="menuitem"
              className="w-full rounded-lg px-2 py-1.5 text-left text-[hsl(var(--foreground))] transition hover:bg-[hsl(var(--muted)_/_0.65)]"
              onClick={() => {
                setOpen(false);
                void copyRssUrl(kind, refId, variant);
              }}
            >
              {variant === "audio" ? "Audio feed" : "Video feed"}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
