"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { trpc } from "@/trpc/react";

/**
 * Per-account credentials for the companion's podcast feeds. The username is
 * the account's email local part; the password is generated server-side and
 * only its hash ever reaches the companion. Regeneration takes effect at the
 * next publish cycle, so old app subscriptions keep working briefly.
 */
export function RssFeedsSection() {
  const utils = trpc.useUtils();
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);

  const query = trpc.settings.rssFeeds.useQuery();
  const regenerate = trpc.settings.regenerateRssPass.useMutation({
    onSuccess: () => {
      setConfirmRegenerate(false);
      void utils.settings.rssFeeds.invalidate();
    },
  });

  const creds = query.data;
  const feedBase = creds?.companionUrl
    ? creds.companionUrl.replace(
        /^(https?:\/\/)/,
        `$1${encodeURIComponent(creds.username)}:${creds.pass}@`,
      )
    : null;
  const queueUrl = feedBase ? `${feedBase}/rss/queue/queue.audio.xml` : null;

  const copy = (label: string, value: string) => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Podcast feeds (RSS)</h2>
      <p className="text-sm text-[hsl(var(--muted-foreground))]">
        Subscribe to your queue, playlists and channels in a podcast app. Feeds
        are unlocked by your personal credentials below; media still only plays
        on the home network.
      </p>
      {creds ? (
        <div className="space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[hsl(var(--muted-foreground))]">
              Username
            </span>
            <code className="rounded bg-[hsl(var(--muted))] px-1.5 py-0.5">
              {creds.username}
            </code>
            <span className="text-[hsl(var(--muted-foreground))]">
              Password
            </span>
            <code className="rounded bg-[hsl(var(--muted))] px-1.5 py-0.5">
              {creds.pass}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => copy("creds", `${creds.username}:${creds.pass}`)}
            >
              {copied === "creds" ? "Copied" : "Copy"}
            </Button>
          </div>
          {queueUrl ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[hsl(var(--muted-foreground))]">
                Queue feed
              </span>
              <code className="max-w-full truncate rounded bg-[hsl(var(--muted))] px-1.5 py-0.5">
                {queueUrl}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => copy("queue", queueUrl)}
              >
                {copied === "queue" ? "Copied" : "Copy"}
              </Button>
            </div>
          ) : null}
          {creds.companionUrl ? (
            <p className="text-[hsl(var(--muted-foreground))]">
              All feeds (channels, playlists, saved):{" "}
              <a
                className="underline"
                href={creds.companionUrl}
                target="_blank"
                rel="noreferrer"
              >
                {creds.companionUrl}
              </a>{" "}
              — sign in with the credentials above.
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            {confirmRegenerate ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => regenerate.mutate()}
                  disabled={regenerate.isPending}
                >
                  {regenerate.isPending
                    ? "Regenerating…"
                    : "Yes, break existing subscriptions"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmRegenerate(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmRegenerate(true)}
              >
                Regenerate password
              </Button>
            )}
          </div>
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            A new password reaches the feed server at the next publish (within
            ~30 minutes); update your podcast apps afterwards.
          </p>
        </div>
      ) : (
        <p className="text-sm text-[hsl(var(--muted-foreground))]">Loading…</p>
      )}
    </section>
  );
}
