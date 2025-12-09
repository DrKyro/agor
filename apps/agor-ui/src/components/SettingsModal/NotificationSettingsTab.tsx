import type { User } from '@agor/core/types';
import { BellOutlined, DesktopOutlined, SoundOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useThemedMessage } from '../../utils/message';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DesktopNotificationPermission,
  getDesktopNotificationPermission,
  mergeNotificationPreferences,
  requestDesktopNotificationPermission,
} from '../../utils/notifications';

const { Paragraph, Text } = Typography;

interface NotificationSettingsTabProps {
  user: User | null;
  form: ReturnType<typeof Form.useForm>[0];
  isOpen: boolean;
}

const STRATEGY_DESCRIPTIONS: Record<'smart' | 'always-desktop' | 'toast-only', string> = {
  smart: 'Use engagement-aware routing. Toasts in the foreground, desktop + audio in the background.',
  'always-desktop': 'Always show desktop notifications (if permitted) regardless of tab focus.',
  'toast-only': 'Never trigger desktop notifications. Use toast + audio only.',
};

const PERMISSION_META: Record<DesktopNotificationPermission, { label: string; color: string; helper: string }> = {
  granted: {
    label: 'Granted',
    color: 'green',
    helper: 'Browser will display desktop notifications when requested.',
  },
  default: {
    label: 'Not Requested',
    color: 'blue',
    helper: 'Click the button below to ask your browser for permission.',
  },
  denied: {
    label: 'Blocked',
    color: 'red',
    helper: 'Browser is blocking notifications. Enable them in site settings.',
  },
  unsupported: {
    label: 'Unsupported',
    color: 'default',
    helper: 'This browser does not expose the Notification API.',
  },
};

export const NotificationSettingsTab: React.FC<NotificationSettingsTabProps> = ({
  user,
  form,
  isOpen,
}) => {
  const { showSuccess, showWarning, showError, showInfo } = useThemedMessage();
  const [permission, setPermission] = useState<DesktopNotificationPermission>(
    getDesktopNotificationPermission()
  );
  const [requestingPermission, setRequestingPermission] = useState(false);

  const notificationPrefs = useMemo(
    () => mergeNotificationPreferences(user?.preferences?.notifications),
    [user?.preferences?.notifications]
  );

  useEffect(() => {
    if (isOpen) {
      setPermission(getDesktopNotificationPermission());
    }
  }, [isOpen]);

  const handlePermissionRequest = async () => {
    if (permission === 'unsupported') return;
    setRequestingPermission(true);
    try {
      const result = await requestDesktopNotificationPermission();
      setPermission(result);
      if (result === 'granted') {
        showSuccess('Desktop notifications enabled. We will alert you when tasks finish.');
      } else if (result === 'denied') {
        showWarning('Desktop notifications remain blocked. Update browser site settings to allow them.');
      } else if (result === 'default') {
        showInfo('Browser dismissed the prompt. Click the address-bar icon to allow notifications.');
      } else if (result === 'unsupported') {
        showWarning('Notifications are not supported in this browser.');
      }
    } catch (error) {
      console.error('Failed to request desktop notification permission:', error);
      showError('Unable to request desktop notification permission. Please adjust browser settings manually.');
    } finally {
      setRequestingPermission(false);
    }
  };

  const permissionMeta = PERMISSION_META[permission] ?? PERMISSION_META.default;

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Text strong style={{ fontSize: 16 }}>
          <BellOutlined /> Smart Notifications
        </Text>
        <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
          Configure how Agor routes toasts, desktop notifications, and task-completion chimes.
        </Paragraph>
      </div>

      <Form
        form={form}
        layout="vertical"
        initialValues={{
          strategy: notificationPrefs.strategy ?? DEFAULT_NOTIFICATION_PREFERENCES.strategy,
          desktopEnabled: notificationPrefs.desktop.enabled,
          desktopRequireInteraction: notificationPrefs.desktop.requireInteraction ?? false,
          desktopSilent: notificationPrefs.desktop.silent ?? false,
          toastEnabled: notificationPrefs.toast.enabled,
        }}
      >
        <Form.Item
          name="strategy"
          label="Notification Strategy"
          tooltip="Choose how Agor coordinates toast, desktop, and audio events."
        >
          <Select
            options={[
              { label: 'Smart (recommended)', value: 'smart' },
              { label: 'Always show desktop notifications', value: 'always-desktop' },
              { label: 'Toast only (no desktop)', value: 'toast-only' },
            ]}
          />
        </Form.Item>
        <Form.Item noStyle shouldUpdate={(prev, curr) => prev.strategy !== curr.strategy}>
          {() => {
            const value = form.getFieldValue('strategy') ?? 'smart';
            const description = STRATEGY_DESCRIPTIONS[value] ?? STRATEGY_DESCRIPTIONS.smart;
            return (
              <Paragraph type="secondary" style={{ marginTop: 0 }}>
                {description}
              </Paragraph>
            );
          }}
        </Form.Item>

        <Row gutter={16}>
          <Col span={12}>
            <Card title={<span><DesktopOutlined /> Desktop Notifications</span>} bordered>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Form.Item
                  name="desktopEnabled"
                  label="Enable Desktop Notifications"
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <Space size="small" align="center">
                  <Tag color={permissionMeta.color}>{permissionMeta.label}</Tag>
                  <Text type="secondary">{permissionMeta.helper}</Text>
                </Space>
                <Button
                  icon={<DesktopOutlined />}
                  type="primary"
                  onClick={handlePermissionRequest}
                  loading={requestingPermission}
                  disabled={permission === 'unsupported'}
                >
                  {permission === 'granted' ? 'Re-check Permission' : 'Request Permission'}
                </Button>
                {(permission === 'denied' || permission === 'unsupported') && (
                  <Alert
                    type={permission === 'denied' ? 'warning' : 'info'}
                    message={
                      permission === 'denied'
                        ? 'Desktop notifications are blocked.'
                        : 'Desktop notifications are not supported in this environment.'
                    }
                    description={
                      permission === 'denied'
                        ? 'Click the lock icon in your browser, allow Notifications, then reload the page.'
                        : 'Use the audio/Toast channels or switch to a browser that supports the Notification API.'
                    }
                    showIcon
                  />
                )}
                <Form.Item noStyle shouldUpdate={(prev, curr) => prev.desktopEnabled !== curr.desktopEnabled}>
                  {() => {
                    const enabled = form.getFieldValue('desktopEnabled');
                    return (
                      <Space direction="vertical" size={8} style={{ width: '100%' }}>
                        <Form.Item
                          name="desktopRequireInteraction"
                          label="Require Interaction"
                          tooltip="Keep the system notification visible until you click it."
                          valuePropName="checked"
                        >
                          <Switch disabled={!enabled} />
                        </Form.Item>
                        <Form.Item
                          name="desktopSilent"
                          label="Silent Desktop Alerts"
                          tooltip="Let Agor handle audio playback while keeping the OS notification silent."
                          valuePropName="checked"
                        >
                          <Switch disabled={!enabled} />
                        </Form.Item>
                      </Space>
                    );
                  }}
                </Form.Item>
              </Space>
            </Card>
          </Col>
          <Col span={12}>
            <Card title={<span><SoundOutlined /> Toast & Audio</span>} bordered>
              <Form.Item
                name="toastEnabled"
                label="Enable Toast Notifications"
                valuePropName="checked"
                tooltip="Toast messages appear inside Agor even if the desktop notification is disabled."
              >
                <Switch />
              </Form.Item>
              <Paragraph type="secondary" style={{ marginBottom: 0 }}>
                Toasts appear instantly in the UI and always include a copy-to-clipboard icon. Audio
                playback follows the task completion settings from the Audio tab.
              </Paragraph>
            </Card>
          </Col>
        </Row>
      </Form>

      <Card type="inner" size="small" style={{ marginTop: 16 }}>
        <Text strong>Smart strategy rules</Text>
        <ul style={{ marginTop: 8, paddingLeft: 20 }}>
          <li>Foreground tab: show toast only (no desktop popups to reduce noise).</li>
          <li>Background tab: desktop notification + toast + audio chime.</li>
          <li>Hidden/minimized: desktop notification + toast + audio chime.</li>
        </ul>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          Switch to “Always show desktop” to force OS notifications even while focused, or “Toast only”
          to keep everything inside the Agor UI.
        </Paragraph>
      </Card>
    </div>
  );
};
