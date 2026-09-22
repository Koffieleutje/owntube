import * as SecureStore from "expo-secure-store";
import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { trpcClient } from "@/lib/trpc";

/**
 * The receiving end of "Play on TV" (web: the watch page's button). While the
 * app is in the foreground it polls `tvRemote.poll`, which both tells the
 * server this TV is on and collects any video sent to it.
 */
const DEVICE_ID_KEY = "owntube.device-id";
const POLL_MS = 2500;

let deviceIdPromise: Promise<string> | null = null;

/** A random id for this TV, made once and kept (device tokens carry none). */
function deviceId(): Promise<string> {
  deviceIdPromise ??= SecureStore.getItemAsync(DEVICE_ID_KEY).then(
    async (stored) => {
      if (stored) return stored;
      const id = Array.from({ length: 16 }, () =>
        Math.floor(Math.random() * 16).toString(16),
      ).join("");
      await SecureStore.setItemAsync(DEVICE_ID_KEY, id).catch(() => {});
      return id;
    },
  );
  return deviceIdPromise;
}

/** How the TV is listed on the web ("Play on Living room TV"). */
function deviceName(): string {
  const model = (Platform.constants as { Model?: string }).Model;
  return model ? `TV (${model})`.slice(0, 60) : "TV";
}

export function useTvRemoteReceiver(
  onPlay: (videoId: string, startSeconds?: number) => void,
) {
  const onPlayRef = useRef(onPlay);
  onPlayRef.current = onPlay;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let active = AppState.currentState === "active";

    const tick = async () => {
      if (stopped) return;
      if (active) {
        try {
          const { command } = await trpcClient.tvRemote.poll.query({
            deviceId: await deviceId(),
            name: deviceName(),
          });
          if (command && !stopped) {
            onPlayRef.current(command.videoId, command.startSeconds);
          }
        } catch {
          // Offline, or a server without Play on TV: try again next tick.
        }
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };

    const sub = AppState.addEventListener("change", (state) => {
      active = state === "active";
    });
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, []);
}
