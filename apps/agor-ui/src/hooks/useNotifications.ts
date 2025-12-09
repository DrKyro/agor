import type { Task, User } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { useCallback, useMemo, useState } from 'react';
import { playTaskCompletionChime } from '../utils/audio';
import { useThemedMessage } from '../utils/message';
import {
  computeNotificationDecision,
  DesktopNotificationPermission,
  getDesktopNotificationPermission,
  mergeNotificationPreferences,
  requestDesktopNotificationPermission,
  showDesktopNotification,
} from '../utils/notifications';

interface NotifyTaskOptions {
  sessionName?: string;
}

interface UseNotificationsOptions extends NotifyTaskOptions {}

interface UseNotificationsResult {
  desktopPermission: DesktopNotificationPermission;
  requestDesktopPermission: () => Promise<DesktopNotificationPermission>;
  notifyTaskCompletion: (task: Task, options?: NotifyTaskOptions) => void;
}

/**
 * Hook to coordinate toast, desktop, and audio notifications
 */
export function useNotifications(
  user: User | null,
  options: UseNotificationsOptions = {}
): UseNotificationsResult {
  const { sessionName: defaultSessionName } = options;
  const [desktopPermission, setDesktopPermission] = useState<DesktopNotificationPermission>(
    getDesktopNotificationPermission()
  );
  const { showSuccess, showWarning } = useThemedMessage();

  const notificationPrefs = useMemo(
    () => mergeNotificationPreferences(user?.preferences?.notifications),
    [user?.preferences?.notifications]
  );

  const notifyTaskCompletion = useCallback(
    (task: Task, context?: NotifyTaskOptions) => {
      const sessionName = context?.sessionName ?? defaultSessionName;
      const decision = computeNotificationDecision({
        strategy: notificationPrefs.strategy,
        desktopEnabled: notificationPrefs.desktop?.enabled,
        toastEnabled: notificationPrefs.toast?.enabled,
        desktopPermission,
      });

      const statusLabel = task.status === TaskStatus.FAILED ? 'Task failed' : 'Task completed';
      const sessionSuffix = sessionName ? ` • ${sessionName}` : '';
      const summary = buildTaskSummary(task);

      // Toast notifications help even when tab is focused
      if (decision.showToast) {
        const message = summary
          ? `${statusLabel}${sessionSuffix}: ${summary}`
          : `${statusLabel}${sessionSuffix}`;
        const toast = task.status === TaskStatus.FAILED ? showWarning : showSuccess;
        toast(message, { duration: 4 });
      }

      // Desktop notification when background/minimized (depending on strategy)
      if (decision.showDesktop) {
        showDesktopNotification({
          title: `${statusLabel}${sessionSuffix}`,
          body: summary,
          tag: `task-${task.task_id}`,
          requireInteraction: notificationPrefs.desktop?.requireInteraction,
          silent: notificationPrefs.desktop?.silent,
        });
      }

      // Audio only when strategy allows (background/minimized)
      if (decision.allowAudio) {
        void playTaskCompletionChime(task, user?.preferences?.audio);
      }
    },
    [
      defaultSessionName,
      desktopPermission,
      notificationPrefs,
      showSuccess,
      showWarning,
      user?.preferences?.audio,
    ]
  );

  const requestDesktopPermission = useCallback(async () => {
    const permission = await requestDesktopNotificationPermission();
    setDesktopPermission(permission);
    return permission;
  }, []);

  return {
    desktopPermission,
    requestDesktopPermission,
    notifyTaskCompletion,
  };
}

/**
 * Summarize a task for notifications
 */
function buildTaskSummary(task: Task): string {
  if (task.description) {
    return task.description;
  }

  if (task.full_prompt) {
    const collapsed = task.full_prompt.trim().replace(/\s+/g, ' ');
    if (collapsed.length > 140) {
      return `${collapsed.slice(0, 137)}…`;
    }
    return collapsed;
  }

  return '';
}
