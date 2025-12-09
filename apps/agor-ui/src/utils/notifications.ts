import type { NotificationPreferences, NotificationStrategy } from '@agor/core/types';

/**
 * Desktop notification permission enriched with unsupported state
 */
export type DesktopNotificationPermission = NotificationPermission | 'unsupported';

/**
 * Default notification preferences
 */
export const DEFAULT_NOTIFICATION_PREFERENCES: Required<NotificationPreferences> = {
  strategy: 'smart',
  desktop: {
    enabled: true,
    requireInteraction: false,
    silent: false,
  },
  toast: {
    enabled: true,
  },
};

/**
 * Merge user notification preferences with defaults
 */
export function mergeNotificationPreferences(
  prefs?: NotificationPreferences | null
): NotificationPreferences {
  return {
    strategy: prefs?.strategy ?? DEFAULT_NOTIFICATION_PREFERENCES.strategy,
    desktop: {
      ...DEFAULT_NOTIFICATION_PREFERENCES.desktop,
      ...prefs?.desktop,
    },
    toast: {
      ...DEFAULT_NOTIFICATION_PREFERENCES.toast,
      ...prefs?.toast,
    },
  };
}

/**
 * Determine if the Notification API is supported
 */
export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Resolve the current desktop notification permission
 */
export function getDesktopNotificationPermission(): DesktopNotificationPermission {
  if (!isNotificationSupported()) {
    return 'unsupported';
  }
  return Notification.permission;
}

/**
 * Request permission to show desktop notifications
 */
export async function requestDesktopNotificationPermission(): Promise<DesktopNotificationPermission> {
  if (!isNotificationSupported()) {
    return 'unsupported';
  }

  try {
    const permission = await Notification.requestPermission();
    return permission;
  } catch (error) {
    console.error('Failed to request desktop notification permission:', error);
    return Notification.permission;
  }
}

/**
 * Convert a relative asset path into an absolute URL that works with Vite base paths
 */
function resolveAssetUrl(relativePath: string): string {
  const baseUrl = import.meta.env?.BASE_URL ?? '/';
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const sanitizedRelative = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
  const combinedPath = `${normalizedBase}${sanitizedRelative}`;

  if (typeof window !== 'undefined') {
    return new URL(combinedPath, window.location.origin).href;
  }

  return combinedPath;
}

const DEFAULT_NOTIFICATION_ICON = resolveAssetUrl('/favicon.png');

/**
 * Engagement states for smart notification routing
 */
export type EngagementState = 'foreground' | 'background' | 'hidden' | 'unknown';

/**
 * Determine current document engagement state (foreground/background/minimized)
 */
export function getEngagementState(): EngagementState {
  if (typeof document === 'undefined') {
    return 'unknown';
  }

  const visibilityState = document.visibilityState;
  const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true;

  if (visibilityState === 'hidden') {
    return 'hidden';
  }

  if (visibilityState === 'visible' && hasFocus) {
    return 'foreground';
  }

  if (visibilityState === 'visible' && !hasFocus) {
    return 'background';
  }

  return 'unknown';
}

/**
 * Decision output for notification routing
 */
export interface NotificationDecision {
  showDesktop: boolean;
  showToast: boolean;
  allowAudio: boolean;
  engagementState: EngagementState;
}

/**
 * Inputs for notification decision logic
 */
export interface NotificationDecisionOptions {
  strategy?: NotificationStrategy;
  desktopEnabled?: boolean;
  toastEnabled?: boolean;
  desktopPermission?: DesktopNotificationPermission;
  engagementState?: EngagementState;
}

/**
 * Compute notification routing for the current state/preferences
 */
export function computeNotificationDecision(
  options: NotificationDecisionOptions = {}
): NotificationDecision {
  const {
    strategy = DEFAULT_NOTIFICATION_PREFERENCES.strategy,
    desktopEnabled = DEFAULT_NOTIFICATION_PREFERENCES.desktop?.enabled ?? true,
    toastEnabled = DEFAULT_NOTIFICATION_PREFERENCES.toast?.enabled ?? true,
    desktopPermission = getDesktopNotificationPermission(),
    engagementState = getEngagementState(),
  } = options;

  const backgroundLike = engagementState === 'background' || engagementState === 'hidden';
  const canShowDesktop = desktopEnabled && desktopPermission === 'granted';

  let showDesktop = false;
  let allowAudio = false;

  switch (strategy) {
    case 'always-desktop':
      showDesktop = canShowDesktop;
      allowAudio = backgroundLike;
      break;
    case 'toast-only':
      showDesktop = false;
      allowAudio = false;
      break;
    case 'smart':
    default:
      showDesktop = canShowDesktop && backgroundLike;
      allowAudio = backgroundLike;
      break;
  }

  return {
    showDesktop,
    showToast: toastEnabled,
    allowAudio,
    engagementState,
  };
}

/**
 * Desktop notification payload (extends the browser Notification options)
 */
export interface DesktopNotificationPayload extends NotificationOptions {
  title: string;
}

/**
 * Show a desktop notification if permissions allow
 */
export function showDesktopNotification(payload: DesktopNotificationPayload): Notification | null {
  if (!isNotificationSupported()) {
    return null;
  }

  if (Notification.permission !== 'granted') {
    return null;
  }

  try {
    const { title, icon, ...options } = payload;
    return new Notification(title, {
      ...options,
      icon: icon ?? DEFAULT_NOTIFICATION_ICON,
    });
  } catch (error) {
    console.error('Failed to show desktop notification:', error);
    return null;
  }
}
