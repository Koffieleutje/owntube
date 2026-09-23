/**
 * Remote transport keys, handled once.
 *
 * expo-video registers a media3 MediaSession for every player it creates (see
 * ExpoVideoPlaybackService.registerPlayer — it happens whether or not the
 * now-playing notification is enabled). Android hands that session the media
 * keys from `PhoneWindow.onKeyDown/onKeyUp`, the fallback it runs once the
 * foreground activity reports the key as unhandled — and React Native never
 * claims a key, it only mirrors it to JS as a TV event.
 *
 * So both ran: the session toggled ExoPlayer on ACTION_DOWN and WatchScreen's
 * TVEventHandler toggled it back on ACTION_UP, leaving Play/Pause looking dead
 * (pause + resume within ~60ms) while the on-screen button, which only goes
 * through JS, worked. Fast-forward and rewind stacked the session's 15s/5s
 * seek on top of the app's own 10s.
 *
 * Consuming the keys in the activity stops the fallback from running, so the
 * app's own handler is the only one. The session keeps the keys whenever the
 * activity isn't in front, which is where it belongs.
 */
const {
  withMainActivity,
  createRunOncePlugin,
} = require("expo/config-plugins");

const HELPER = `
  /** Transport keys WatchScreen handles itself (see with-media-keys plugin). */
  private val ownTransportKeys = setOf(
    android.view.KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
    android.view.KeyEvent.KEYCODE_MEDIA_PLAY,
    android.view.KeyEvent.KEYCODE_MEDIA_PAUSE,
    android.view.KeyEvent.KEYCODE_MEDIA_NEXT,
    android.view.KeyEvent.KEYCODE_MEDIA_PREVIOUS,
    android.view.KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,
    android.view.KeyEvent.KEYCODE_MEDIA_REWIND,
  )

  /**
   * super dispatches through the view hierarchy, where ReactRootView turns the
   * key into a TV event for JS. Reporting it handled afterwards keeps
   * PhoneWindow from also passing it to expo-video's MediaSession, which would
   * act on the same press a second time.
   */
  override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean {
    val handled = super.dispatchKeyEvent(event)
    return handled || ownTransportKeys.contains(event.keyCode)
  }
`;

const withMediaKeys = (config) =>
  withMainActivity(config, (config) => {
    const src = config.modResults.contents;
    if (src.includes("ownTransportKeys")) return config;

    // Append inside the class, before its final brace.
    const lastBrace = src.lastIndexOf("}");
    config.modResults.contents = `${src.slice(0, lastBrace)}${HELPER}${src.slice(
      lastBrace,
    )}`;
    return config;
  });

module.exports = createRunOncePlugin(withMediaKeys, "with-media-keys", "1.0.0");
