/**
 * "Play on TV": the web (or phone) sends a video to a paired TV.
 *
 * Each TV polls `tvRemote.poll` every couple of seconds while the app is in
 * the foreground, identifying itself with an id it generated and keeps on the
 * device (device tokens carry only the user). A poll both marks the TV as
 * present and collects any video sent to it. Held in memory, like pairing
 * sessions: a restart only forgets which TVs are awake, and they re-announce
 * within seconds.
 */

/**
 * A TV that hasn't polled for this long is treated as off, and a video sent
 * to it but not collected goes with it.
 */
const PRESENCE_TTL_MS = 30_000;

export type TvCommand = {
  videoId: string;
  startSeconds?: number;
  sentAt: number;
};

type TvDevice = {
  deviceId: string;
  name: string;
  /** An Android emulator: kept out of the web's list of TVs. */
  emulator: boolean;
  lastSeen: number;
  pending: TvCommand | null;
};

type TvRemoteStore = { byUser: Map<number, Map<string, TvDevice>> };

declare global {
  var __owntubeTvRemoteStore: TvRemoteStore | undefined;
}

function store(): TvRemoteStore {
  globalThis.__owntubeTvRemoteStore ??= { byUser: new Map() };
  return globalThis.__owntubeTvRemoteStore;
}

function devicesOf(userId: number): Map<string, TvDevice> {
  const all = store().byUser;
  let devices = all.get(userId);
  if (!devices) {
    devices = new Map();
    all.set(userId, devices);
  }
  return devices;
}

function prune(devices: Map<string, TvDevice>, now: number) {
  for (const [id, device] of devices) {
    if (now - device.lastSeen > PRESENCE_TTL_MS) devices.delete(id);
  }
}

/**
 * Whether a TV name is an Android emulator's, for TV builds that don't report
 * it themselves (the stock TV image's model is "AOSP TV on x86").
 */
export function looksLikeEmulator(name: string): boolean {
  return /\b(AOSP|sdk_\w*|emulator|SDK built for)\b/i.test(name);
}

/** A TV checks in; returns (and clears) what was sent to it, if anything. */
export function pollTv(
  userId: number,
  deviceId: string,
  name: string,
  now = Date.now(),
  emulator = false,
): TvCommand | null {
  const devices = devicesOf(userId);
  prune(devices, now);
  const device = devices.get(deviceId) ?? {
    deviceId,
    name,
    emulator,
    lastSeen: now,
    pending: null,
  };
  device.name = name;
  device.emulator = emulator;
  device.lastSeen = now;
  devices.set(deviceId, device);
  const command = device.pending;
  device.pending = null;
  return command;
}

/** TVs of this user that are awake right now, emulators left out. */
export function listTvs(
  userId: number,
  now = Date.now(),
): { deviceId: string; name: string }[] {
  const devices = devicesOf(userId);
  prune(devices, now);
  return [...devices.values()]
    .filter((device) => !device.emulator)
    .map(({ deviceId, name }) => ({ deviceId, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Queues a video for one TV; false when that TV isn't awake. */
export function sendToTv(
  userId: number,
  deviceId: string,
  command: Omit<TvCommand, "sentAt">,
  now = Date.now(),
): boolean {
  const devices = devicesOf(userId);
  prune(devices, now);
  const device = devices.get(deviceId);
  if (!device) return false;
  device.pending = { ...command, sentAt: now };
  return true;
}
