package expo.modules.watchnext

import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.tvprovider.media.tv.TvContractCompat
import androidx.tvprovider.media.tv.WatchNextProgram
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/** One video for the Android TV home screen's "Continue watching" row. */
class WatchNextItem : Record {
  @Field var videoId: String = ""
  @Field var title: String = ""
  @Field var channelName: String? = null
  @Field var posterUrl: String? = null
  @Field var positionMs: Double = 0.0
  @Field var durationMs: Double = 0.0
}

/**
 * Publishes half-watched videos to the system Watch Next row
 * (TvContractCompat.WatchNextPrograms), keyed by video id through the
 * program's internal provider id. Each program opens the app on
 * `owntube://watch?v=<id>`, which resumes from the stored position.
 *
 * Every call is best-effort: a launcher without the TV provider (a phone, an
 * old Fire OS) just has no row, and a failure never reaches the player.
 */
class WatchNextModule : Module() {
  private val resolver get() = appContext.reactContext?.contentResolver

  override fun definition() = ModuleDefinition {
    Name("WatchNext")

    AsyncFunction("upsert") { item: WatchNextItem ->
      safely("upsert") { upsert(item) }
    }

    AsyncFunction("remove") { videoId: String ->
      safely("remove") { remove(videoId) }
    }
  }

  private fun safely(what: String, block: () -> Unit): Boolean =
    try {
      block()
      true
    } catch (e: Exception) {
      Log.w("WatchNext", "$what failed", e)
      false
    }

  private fun programIdFor(videoId: String): Long? {
    val cursor = resolver?.query(
      TvContractCompat.WatchNextPrograms.CONTENT_URI,
      arrayOf(
        TvContractCompat.WatchNextPrograms._ID,
        TvContractCompat.WatchNextPrograms.COLUMN_INTERNAL_PROVIDER_ID,
      ),
      null,
      null,
      null,
    ) ?: return null
    cursor.use {
      while (it.moveToNext()) {
        if (it.getString(1) == videoId) return it.getLong(0)
      }
    }
    return null
  }

  private fun upsert(item: WatchNextItem) {
    val builder = WatchNextProgram.Builder()
      .setType(TvContractCompat.WatchNextPrograms.TYPE_CLIP)
      .setWatchNextType(TvContractCompat.WatchNextPrograms.WATCH_NEXT_TYPE_CONTINUE)
      .setLastEngagementTimeUtcMillis(System.currentTimeMillis())
      .setTitle(item.title)
      .setInternalProviderId(item.videoId)
      .setLastPlaybackPositionMillis(item.positionMs.toInt())
      .setDurationMillis(item.durationMs.toInt())
      .setIntent(Intent(Intent.ACTION_VIEW, Uri.parse("owntube://watch?v=${Uri.encode(item.videoId)}")))
    item.channelName?.let { builder.setDescription(it) }
    item.posterUrl?.let {
      builder
        .setPosterArtUri(Uri.parse(it))
        .setPosterArtAspectRatio(TvContractCompat.PreviewProgramColumns.ASPECT_RATIO_16_9)
    }
    val values = builder.build().toContentValues()
    val existing = programIdFor(item.videoId)
    if (existing != null) {
      resolver?.update(TvContractCompat.buildWatchNextProgramUri(existing), values, null, null)
    } else {
      resolver?.insert(TvContractCompat.WatchNextPrograms.CONTENT_URI, values)
    }
  }

  private fun remove(videoId: String) {
    val existing = programIdFor(videoId) ?: return
    resolver?.delete(TvContractCompat.buildWatchNextProgramUri(existing), null, null)
  }
}
