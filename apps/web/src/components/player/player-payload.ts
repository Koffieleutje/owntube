/** A subtitle track ready to attach to a `<video>` (same-origin VTT src). */
export type CaptionTrack = {
  label: string;
  languageCode: string;
  /** Same-origin `/captions/{videoId}?label=…` URL serving WebVTT. */
  src: string;
};

export type ProxiedVariant =
  | { t: "muxed"; label: string; src: string }
  | {
      t: "split";
      label: string;
      video: string;
      audio: string;
      audioTracks: { label: string; src: string }[];
      defaultAudioIndex?: number;
    };

export type VideoPlayerPayload =
  | {
      mode: "hls";
      src: string;
      /**
       * Post-Live-DVR (an ended livestream YouTube hasn't converted to VOD).
       * `src` is our `/hls/<id>` path, but nothing can be synthesized there —
       * the player must upgrade to `/dash`, which proxies invidious-companion's
       * manifest. Lets the player keep DASH on iOS for this case alone; see
       * `hls-vod-block.tsx`.
       */
      dvr?: boolean;
    }
  | { mode: "progressive"; variants: ProxiedVariant[] };
