import type { AgorClient } from '@agor/core/api';
import type { AgorConfig } from '@agor/core/config';
import type { User } from '@agor/core/types';
import { CopyOutlined, KeyOutlined, ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { Alert, Button, Divider, Input, Space, Switch, Typography, theme } from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getDaemonUrl } from '../../config/daemon';
import { useThemedMessage } from '../../utils/message';

export interface MCPAccessTabProps {
  client: AgorClient | null;
  currentUser?: User | null;
}

function generateRandomHexToken(bytes: number = 32): string {
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    const buffer = new Uint8Array(bytes);
    window.crypto.getRandomValues(buffer);
    return Array.from(buffer)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  // Fallback (older environments): not cryptographically strong, but better than blocking UI.
  const parts: string[] = [];
  for (let i = 0; i < bytes; i++) {
    parts.push(
      Math.floor(Math.random() * 256)
        .toString(16)
        .padStart(2, '0')
    );
  }
  return parts.join('');
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const MCPAccessTab: React.FC<MCPAccessTabProps> = ({ client, currentUser }) => {
  const { token } = theme.useToken();
  const { showSuccess, showError } = useThemedMessage();
  const showErrorRef = useRef(showError);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [maskedCurrentToken, setMaskedCurrentToken] = useState<string | null>(null);
  const [newToken, setNewToken] = useState('');
  const [globalUserId, setGlobalUserId] = useState('');

  const daemonUrl = useMemo(() => getDaemonUrl(), []);
  const mcpBaseUrl = useMemo(() => {
    try {
      return new URL('/mcp', daemonUrl).toString();
    } catch {
      return `${daemonUrl.replace(/\/+$/, '')}/mcp`;
    }
  }, [daemonUrl]);

  useEffect(() => {
    if (!client) return;

    const load = async () => {
      try {
        setLoading(true);
        const daemonCfg = (await client.service('config').get('daemon')) as
          | AgorConfig['daemon']
          | undefined;

        setMcpEnabled(daemonCfg?.mcpEnabled !== false);
        setMaskedCurrentToken(daemonCfg?.mcpGlobalToken ? String(daemonCfg.mcpGlobalToken) : null);
        setGlobalUserId(
          daemonCfg?.mcpGlobalUserId || currentUser?.user_id || daemonCfg?.mcpGlobalUserId || ''
        );
      } catch (err) {
        console.error('Failed to load daemon config:', err);
        showErrorRef.current(
          err instanceof Error ? err.message : '加载配置失败（需要 admin 权限）'
        );
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [client, currentUser?.user_id]);

  useEffect(() => {
    showErrorRef.current = showError;
  }, [showError]);

  const handleGenerate = () => {
    setNewToken(generateRandomHexToken(32));
  };

  const handleCopyUrl = async () => {
    const url = `${mcpBaseUrl}?mcpToken=${newToken || '<YOUR_TOKEN>'}`;
    const ok = await copyToClipboard(url);
    ok ? showSuccess('已复制 MCP URL') : showError('复制失败（浏览器权限限制）');
  };

  const handleCopyHeader = async () => {
    const header = `Authorization: Bearer ${newToken || '<YOUR_TOKEN>'}`;
    const ok = await copyToClipboard(header);
    ok ? showSuccess('已复制 Header') : showError('复制失败（浏览器权限限制）');
  };

  const handleSave = async () => {
    if (!client) return;

    try {
      setSaving(true);

      const patch: Partial<AgorConfig> = {
        daemon: {
          mcpEnabled,
          mcpGlobalUserId: globalUserId || undefined,
          ...(newToken ? { mcpGlobalToken: newToken } : {}),
        },
      };

      await client.service('config').patch(null, patch);

      showSuccess('已保存 MCP 全局访问设置');
      setMaskedCurrentToken(newToken ? `${newToken.slice(0, 10)}...` : maskedCurrentToken);
      setNewToken('');
    } catch (err) {
      console.error('Failed to save MCP access config:', err);
      showError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleClearToken = async () => {
    if (!client) return;

    try {
      setSaving(true);
      await client.service('config').patch(null, {
        daemon: {
          mcpGlobalToken: undefined,
        },
      });
      showSuccess('已清除全局 MCP Token');
      setMaskedCurrentToken(null);
      setNewToken('');
    } catch (err) {
      console.error('Failed to clear MCP global token:', err);
      showError(err instanceof Error ? err.message : '清除失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: token.paddingMD }}>
      <Alert
        type="info"
        showIcon
        icon={<KeyOutlined />}
        message="全局 MCP 访问（外部客户端 → Agor）"
        description={
          <div>
            <div style={{ marginBottom: token.marginXS }}>
              用于让外部 AI 客户端通过 MCP 调用 Agor
              的工具（创建项目/画布/worktree/session、运行任务、读取聊天记录）。
              外部只下达指令，真正执行由 Agor 内部 agent executor 完成。
            </div>
            <div>
              MCP Endpoint：<Typography.Text code>{mcpBaseUrl}</Typography.Text>
            </div>
          </div>
        }
        style={{ marginBottom: token.marginLG }}
      />

      <form
        onSubmit={(e) => e.preventDefault()}
        style={{ opacity: loading ? 0.6 : 1, pointerEvents: loading ? 'none' : 'auto' }}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <Typography.Title level={5} style={{ margin: 0 }}>
                MCP 开关
              </Typography.Title>
              <Typography.Text type="secondary">
                关闭后 `POST /mcp` 将不可用（外部客户端会断连）
              </Typography.Text>
            </div>
            <Switch checked={mcpEnabled} onChange={setMcpEnabled} />
          </div>

          <Divider style={{ margin: `${token.marginSM}px 0` }} />

          <div>
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              全局 Token
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
              这是“全局控制口”的密钥。建议只在可信网络使用，并设置足够长的随机值。
            </Typography.Paragraph>

            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <Input addonBefore="当前 Token" value={maskedCurrentToken || '（未设置）'} disabled />
              <Input.Password
                addonBefore="新 Token"
                placeholder="留空表示不修改 Token（仅保存开关/归属）"
                value={newToken}
                onChange={(e) => setNewToken(e.target.value)}
                autoComplete="new-password"
              />

              <Space wrap>
                <Button onClick={handleGenerate} icon={<ReloadOutlined />} disabled={saving}>
                  生成随机 Token
                </Button>
                <Button onClick={handleCopyUrl} icon={<CopyOutlined />} disabled={saving}>
                  复制 URL（?mcpToken=…）
                </Button>
                <Button onClick={handleCopyHeader} icon={<CopyOutlined />} disabled={saving}>
                  复制 Header（Authorization）
                </Button>
                <Button danger onClick={handleClearToken} disabled={saving}>
                  清除 Token
                </Button>
              </Space>
            </Space>
          </div>

          <div>
            <Typography.Title level={5} style={{ marginTop: 0 }}>
              归属用户（可选）
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
              仅用于把全局 MCP 的操作归因到某个 user_id（默认 anonymous）。
            </Typography.Paragraph>
            <Input
              placeholder="例如：anonymous 或某个 user_id"
              value={globalUserId}
              onChange={(e) => setGlobalUserId(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button type="primary" icon={<SaveOutlined />} onClick={handleSave} loading={saving}>
              保存
            </Button>
          </div>

          <Alert
            type="warning"
            showIcon
            message="外部客户端配置提示"
            description={
              <div>
                <div style={{ marginBottom: token.marginXS }}>
                  推荐用 Header（不暴露在 URL 日志里）：
                </div>
                <Typography.Paragraph style={{ marginBottom: token.marginXS }}>
                  <Typography.Text code>{mcpBaseUrl}</Typography.Text>
                  <br />
                  <Typography.Text code>Authorization: Bearer {'<YOUR_TOKEN>'}</Typography.Text>
                </Typography.Paragraph>
                <div style={{ marginBottom: token.marginXXS }}>
                  如果客户端不支持自定义 Header，可用 URL 参数：
                </div>
                <Typography.Text code>{`${mcpBaseUrl}?mcpToken=<YOUR_TOKEN>`}</Typography.Text>
              </div>
            }
          />
        </Space>
      </form>
    </div>
  );
};
