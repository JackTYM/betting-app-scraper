/**
 * Local push reminder — nudges the user to sync when 6 hours have passed
 * since the last sync across any book. Uses expo-notifications (local only,
 * no server; works in Expo Go).
 *
 * Call scheduleSyncReminder() after each successful sync.
 * Call cancelSyncReminder() is optional — it's called automatically by reschedule.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// How long after the last sync before the reminder fires (ms).
const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Notification identifier for easy cancellation.
const REMINDER_ID = 'bet-loader-sync-reminder';

/** Request permission and configure foreground presentation (call once at app startup). */
export async function initNotifications(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('sync-reminder', {
      name: 'Sync Reminder',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') {
    console.warn('bet-loader: notification permission not granted; reminders disabled');
    return;
  }

  // Show notifications even while the app is in the foreground.
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

/** Cancel any existing reminder then schedule a new one SYNC_INTERVAL_MS from now. */
export async function scheduleSyncReminder(): Promise<void> {
  try {
    // Cancel any previous scheduled reminder.
    await Notifications.cancelScheduledNotificationAsync(REMINDER_ID).catch(() => {});

    await Notifications.scheduleNotificationAsync({
      identifier: REMINDER_ID,
      content: {
        title: 'Bet Loader',
        body: "Time to sync your bets — it's been 6 hours.",
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
        seconds: Math.floor(SYNC_INTERVAL_MS / 1000),
        repeats: false,
      },
    });
  } catch (e) {
    // Notifications are best-effort; don't crash the app.
    console.warn('bet-loader: could not schedule reminder:', e);
  }
}

/** Cancel the pending sync reminder (e.g., on manual check). */
export async function cancelSyncReminder(): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(REMINDER_ID).catch(() => {});
}
