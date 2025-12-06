import type { AgorClient } from '@agor/core/api';
import type { VSCodeOpenMode } from '@agor/core/types';
import { Alert, Button, Form, Input, Select, Space, Switch, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { useThemedMessage } from '../../utils/message';

const DEFAULT_CODE_SERVER_TEMPLATE =
  'https://codeserver.example.com/?folder={{encodeURIComponent worktree.path}}';

export interface IDETabProps {
  client: AgorClient | null;
}

export const IDETab: React.FC<IDETabProps> = ({ client }) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
  const [loading, setLoading] = useState(true);

  const [vscodeEnabled, setVscodeEnabled] = useState(true);
  const [preferredMode, setPreferredMode] = useState<VSCodeOpenMode>('remote-ssh');
  const [remoteHost, setRemoteHost] = useState('');
  const [remotePort, setRemotePort] = useState<string>('');
  const [remoteUser, setRemoteUser] = useState('');
  const [remoteTarget, setRemoteTarget] = useState('');
  const [tunnelName, setTunnelName] = useState('');
  const [tunnelDisplayName, setTunnelDisplayName] = useState('');

  const [codeServerEnabled, setCodeServerEnabled] = useState(false);
  const [codeServerTemplate, setCodeServerTemplate] = useState(DEFAULT_CODE_SERVER_TEMPLATE);

  useEffect(() => {
    if (!client) return;

    const loadConfig = async () => {
      try {
        setLoading(true);
        const ideConfig = (await client.service('config').get('ide')) as {
          vscode?: {
            enabled?: boolean;
            preferred_mode?: VSCodeOpenMode;
            remote?: { host?: string; port?: number; user?: string; target?: string };
            tunnel?: { name?: string; displayName?: string };
          };
          code_server?: { enabled?: boolean; url_template?: string };
        };

        if (ideConfig?.vscode) {
          setVscodeEnabled(ideConfig.vscode.enabled !== false);
          setPreferredMode(ideConfig.vscode.preferred_mode || 'remote-ssh');
          setRemoteHost(ideConfig.vscode.remote?.host || '');
          setRemotePort(
            ideConfig.vscode.remote?.port !== undefined ? String(ideConfig.vscode.remote.port) : ''
          );
          setRemoteUser(ideConfig.vscode.remote?.user || '');
          setRemoteTarget(ideConfig.vscode.remote?.target || '');
          setTunnelName(ideConfig.vscode.tunnel?.name || '');
          setTunnelDisplayName(ideConfig.vscode.tunnel?.displayName || '');
        }

        if (ideConfig?.code_server) {
          setCodeServerEnabled(ideConfig.code_server.enabled === true);
          setCodeServerTemplate(ideConfig.code_server.url_template || DEFAULT_CODE_SERVER_TEMPLATE);
        }
      } catch (err) {
        console.error('Failed to load IDE config', err);
      } finally {
        setLoading(false);
      }
    };

    loadConfig();
  }, [client]);

  const handleSave = async () => {
    if (!client) return;

    try {
      const portNumber =
        remotePort && !Number.isNaN(Number(remotePort)) ? Number(remotePort) : undefined;

      await client.service('config').patch(null, {
        ide: {
          vscode: {
            enabled: vscodeEnabled,
            preferred_mode: preferredMode,
            remote: {
              host: remoteHost || undefined,
              port: portNumber,
              user: remoteUser || undefined,
              target: remoteTarget || undefined,
            },
            tunnel: {
              name: tunnelName || undefined,
              displayName: tunnelDisplayName || undefined,
            },
          },
          code_server: {
            enabled: codeServerEnabled,
            url_template: codeServerTemplate || undefined,
          },
        },
      });

      showSuccess('IDE 配置已保存');
    } catch (err) {
      const message = err instanceof Error ? err.message : '保存 IDE 配置失败';
      showError(message);
      console.error('Failed to save IDE config', err);
    }
  };

  return (
    <div style={{ padding: token.paddingMD }}>
      <Alert
        type="info"
        showIcon
        message="VS Code 打开方式"
        description={
          <div>
            <p style={{ marginBottom: token.marginXS }}>
              支持 <strong>Remote SSH</strong>、<strong>VS Code Tunnel</strong> 和本地
              <code>vscode://file</code> 三种方式。
            </p>
            <p style={{ marginBottom: 0 }}>
              默认优先使用 Remote SSH，避免 Tunnel 的中转延迟；如果配置缺失则自动回退。
            </p>
          </div>
        }
        style={{ marginBottom: token.marginLG }}
      />

      <Form layout="vertical" disabled={loading}>
        <Form.Item label="启用 VS Code 打开按钮">
          <Space>
            <Switch
              checked={vscodeEnabled}
              onChange={setVscodeEnabled}
              checkedChildren="Enabled"
              unCheckedChildren="Disabled"
            />
            <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>关闭后按钮会隐藏</span>
          </Space>
        </Form.Item>

        <Form.Item label="首选连接模式">
          <Select<VSCodeOpenMode>
            value={preferredMode}
            onChange={setPreferredMode}
            options={[
              { label: 'Remote SSH', value: 'remote-ssh' },
              { label: 'VS Code Tunnel', value: 'tunnel' },
              { label: 'Local (vscode://file)', value: 'local' },
            ]}
            style={{ width: 240 }}
          />
        </Form.Item>

        <Typography.Title level={5} style={{ marginTop: token.marginLG }}>
          Remote SSH
        </Typography.Title>
        <Form.Item label="Host">
          <Input
            placeholder="example.com"
            value={remoteHost}
            onChange={(e) => setRemoteHost(e.target.value)}
          />
        </Form.Item>
        <Form.Item label="Port">
          <Input
            placeholder="22"
            value={remotePort}
            onChange={(e) => setRemotePort(e.target.value)}
          />
        </Form.Item>
        <Form.Item label="User">
          <Input
            placeholder="dev"
            value={remoteUser}
            onChange={(e) => setRemoteUser(e.target.value)}
          />
        </Form.Item>
        <Form.Item
          label="SSH Target (可选)"
          extra="如果使用 ~/.ssh/config 的 Host 别名，请填写该别名；否则留空自动拼接 user@host"
        >
          <Input
            placeholder="my-ssh-alias"
            value={remoteTarget}
            onChange={(e) => setRemoteTarget(e.target.value)}
          />
        </Form.Item>

        <Typography.Title level={5} style={{ marginTop: token.marginLG }}>
          VS Code Tunnel
        </Typography.Title>
        <Form.Item label="Tunnel Name" extra="来自 `code tunnel status`；如不填则不会尝试 Tunnel">
          <Input
            placeholder="agor-prod-tunnel"
            value={tunnelName}
            onChange={(e) => setTunnelName(e.target.value)}
          />
        </Form.Item>
        <Form.Item label="显示名称 (可选)">
          <Input
            placeholder="例如：生产隧道"
            value={tunnelDisplayName}
            onChange={(e) => setTunnelDisplayName(e.target.value)}
          />
        </Form.Item>

        <Typography.Title level={5} style={{ marginTop: token.marginLG }}>
          code-server（浏览器打开）
        </Typography.Title>
        <Form.Item label="启用 code-server 按钮">
          <Switch checked={codeServerEnabled} onChange={setCodeServerEnabled} />
        </Form.Item>
        <Form.Item
          label="URL 模板"
          extra="使用 Handlebars 变量：worktree, repo；默认使用 encodeURIComponent 编码路径"
        >
          <Input.TextArea
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder={DEFAULT_CODE_SERVER_TEMPLATE}
            value={codeServerTemplate}
            onChange={(e) => setCodeServerTemplate(e.target.value)}
          />
        </Form.Item>

        <Space style={{ marginTop: token.marginLG }}>
          <Button type="primary" onClick={handleSave} disabled={loading}>
            保存
          </Button>
        </Space>
      </Form>
    </div>
  );
};
