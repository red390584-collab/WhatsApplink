package com.hybrid.webchat

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * Foreground keep-alive service.
 *
 * The whole app is one long-lived WebView rendering WhatsApp Web, which is very
 * memory hungry. The moment the user switches away to the WhatsApp app to type in
 * the pairing code, Android treats our process as an ordinary cached background app
 * and kills it - so by the time they come back the app has to cold-start and the
 * linking screen (and its code) is gone.
 *
 * Running as a foreground service raises the process to a perceptible priority, so it
 * survives backgrounding for as long as the user needs: while they copy the pairing
 * code, enter it in WhatsApp, and after linking while the session stays live.
 *
 * START_STICKY makes the system recreate the service (and therefore the process) if
 * it ever does get reclaimed, so the WebView session is restored from its own
 * cookies + IndexedDB instead of the app appearing to close.
 */
class KeepAliveService : Service() {

    companion object {
        private const val TAG = "HybridWA"
        private const val CHANNEL_ID = "hybrid_keepalive"
        private const val NOTIFICATION_ID = 4711

        /** Start the keep-alive. Never throws: a failing notification must not crash the app. */
        fun start(context: Context) {
            try {
                val intent = Intent(context, KeepAliveService::class.java)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (e: Exception) {
                Log.e(TAG, "keep-alive start failed", e)
            }
        }

        /** Stop only when the app is genuinely finished (swiped away), never on rotation. */
        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, KeepAliveService::class.java))
            } catch (e: Exception) {
                Log.e(TAG, "keep-alive stop failed", e)
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            val notification = buildNotification()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                )
            } else {
                @Suppress("DEPRECATION")
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (e: Exception) {
            // Even if the platform refuses the foreground promotion the service keeps
            // running; the app must never die because of its own keep-alive.
            Log.e(TAG, "startForeground failed", e)
        }
        return START_STICKY
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.keepalive_channel),
                    NotificationManager.IMPORTANCE_MIN
                )
                channel.setShowBadge(false)
                manager.createNotificationChannel(channel)
            }
        }
    }

    private fun buildNotification(): Notification {
        createChannel()
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle(getString(R.string.keepalive_title))
            .setContentText(getString(R.string.keepalive_text))
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .build()
    }
}
