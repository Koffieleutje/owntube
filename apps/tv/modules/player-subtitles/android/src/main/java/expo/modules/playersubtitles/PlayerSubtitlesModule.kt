package expo.modules.playersubtitles

import android.view.View
import android.view.ViewGroup
import androidx.media3.ui.SubtitleView
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Lifts captions off the bottom edge of the screen.
 *
 * expo-video draws captions with the SubtitleView inside its media3
 * PlayerView and has no prop for where they go. SubtitleView's own
 * bottomPaddingFraction only applies to cues without a position, and
 * YouTube's captions come with one (the last line), so they sit flush
 * against the bottom edge, where overscan can cut them off. Padding the
 * view itself shrinks the box every cue is placed in, positioned or not.
 */
class PlayerSubtitlesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PlayerSubtitles")

    AsyncFunction("setBottomPadding") { fraction: Float ->
      val root = appContext.currentActivity?.window?.decorView ?: return@AsyncFunction
      forEachSubtitleView(root) {
        val height = if (it.height > 0) it.height else root.height
        it.setPadding(it.paddingLeft, it.paddingTop, it.paddingRight, (height * fraction).toInt())
      }
    }.runOnQueue(Queues.MAIN)
  }

  private fun forEachSubtitleView(view: View, action: (SubtitleView) -> Unit) {
    if (view is SubtitleView) action(view)
    if (view is ViewGroup) {
      for (i in 0 until view.childCount) forEachSubtitleView(view.getChildAt(i), action)
    }
  }
}
