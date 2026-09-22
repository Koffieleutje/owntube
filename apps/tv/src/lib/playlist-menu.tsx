import { useState } from "react";
import { FocusableTextInput } from "@/components/focusable-text-input";
import type { MenuItem, MenuPage } from "@/components/MenuPanel";
import { queryClient } from "@/lib/query-client";
import { trpcClient } from "@/lib/trpc";
import { trpc } from "@/lib/trpc-react";

/** Page keys the hook answers to; route these to `buildPage`. */
export const PLAYLIST_PAGES = ["playlists", "newPlaylist"] as const;

/**
 * "Save to playlist" as two menu pages — a checklist of the user's playlists
 * (OK adds or removes) and "New playlist…" with a name field — shared by the
 * player's settings panel and the card context menu.
 *
 * Fetches only while `enabled` (the menu is open).
 */
export function usePlaylistMenu({
  video,
  enabled,
  notify,
  onCreated,
}: {
  video: { videoId: string; channelId?: string | null } | null;
  enabled: boolean;
  notify: (text: string) => void;
  /** After "Create and save" succeeds, e.g. to close the menu. */
  onCreated?: () => void;
}) {
  const playlists = trpc.playlists.list.useQuery(undefined, { enabled });
  const membership = trpc.playlists.membership.useQuery(undefined, {
    enabled,
  });
  const [newName, setNewName] = useState("");

  const inPlaylist = (playlistId: number) =>
    video !== null &&
    (membership.data ?? []).some(
      (m) => m.playlistId === playlistId && m.videoId === video.videoId,
    );

  const refresh = (playlistId?: number) => {
    void membership.refetch();
    void playlists.refetch();
    if (playlistId !== undefined) {
      void queryClient.invalidateQueries({
        queryKey: ["feed", `playlists.itemsDetailed:${playlistId}`],
      });
    }
  };

  const toggle = (playlistId: number, name: string) => {
    if (!video) return;
    const adding = !inPlaylist(playlistId);
    (adding
      ? trpcClient.playlists.addItem.mutate({
          playlistId,
          videoId: video.videoId,
          channelId: video.channelId ?? undefined,
        })
      : trpcClient.playlists.removeItem.mutate({
          playlistId,
          videoId: video.videoId,
        })
    )
      .then(() => {
        notify(adding ? `Saved to ${name}` : `Removed from ${name}`);
        refresh(playlistId);
      })
      .catch(() => notify("Couldn't update the playlist"));
  };

  const create = () => {
    const name = newName.trim();
    if (!video || !name) return;
    trpcClient.playlists.create
      .mutate({ name })
      .then(({ id }) =>
        trpcClient.playlists.addItem
          .mutate({
            playlistId: id,
            videoId: video.videoId,
            channelId: video.channelId ?? undefined,
          })
          .then(() => id),
      )
      .then((id) => {
        setNewName("");
        notify(`Saved to ${name}`);
        refresh(id);
        onCreated?.();
      })
      .catch(() => notify("Couldn't create the playlist"));
  };

  const buildPage = (key: string): MenuPage | null => {
    if (key === "playlists") {
      return {
        title: "Save to playlist",
        items: [
          ...(playlists.data ?? []).map<MenuItem>((playlist) => ({
            key: String(playlist.id),
            label: playlist.name,
            selected: inPlaylist(playlist.id),
            onPress: () => {
              toggle(playlist.id, playlist.name);
              return "stay";
            },
          })),
          { key: "new", label: "New playlist…", submenu: "newPlaylist" },
        ],
      };
    }
    if (key === "newPlaylist") {
      return {
        title: "New playlist",
        content: (
          <FocusableTextInput
            value={newName}
            onChangeText={setNewName}
            placeholder="Playlist name"
            hasTVPreferredFocus
            onSubmitEditing={create}
            returnKeyType="done"
            maxLength={120}
          />
        ),
        items: [
          {
            key: "create",
            label: "Create and save",
            onPress: () => {
              create();
              return "stay";
            },
          },
        ],
      };
    }
    return null;
  };

  return { buildPage };
}
