import type { AgorClient } from '@agor/core/api';
import type { Repo, Worktree } from '@agor/core/types';
import {
  Button,
  Card,
  Col,
  Divider,
  Input,
  Row,
  Space,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SaveOutlined, EditOutlined, DeleteOutlined, FileTextOutlined } from '@ant-design/icons';
import { useThemedMessage } from '@/utils/message';

const { Paragraph, Text } = Typography;
const { TextArea } = Input;

interface EnvTabProps {
  worktree: Worktree;
  repo: Repo;
  client: AgorClient | null;
  onUpdateWorktree?: (worktreeId: string, updates: Partial<Worktree>) => void;
}

/**
 * EnvTab - Consolidated environment view for a worktree
 *
 * - Shows repo-level env settings (file name, auto-write flag, repo env keys)
 * - Provides worktree-scoped .env editor and write-to-file action
 */
export const EnvTab: React.FC<EnvTabProps> = ({ worktree, repo, client, onUpdateWorktree }) => {
  const { token } = theme.useToken();
  const { showError, showSuccess } = useThemedMessage();

  const [isEditingWorktreeEnv, setIsEditingWorktreeEnv] = useState(false);
  const [worktreeEnvText, setWorktreeEnvText] = useState(worktree.env_vars_text || '');
  const [savedWorktreeEnvText, setSavedWorktreeEnvText] = useState(worktree.env_vars_text || '');
  const [savingWorktreeEnv, setSavingWorktreeEnv] = useState(false);
  const [loadingUserRepoEnv, setLoadingUserRepoEnv] = useState(false);
  const [userRepoEnvKeys, setUserRepoEnvKeys] = useState<string[]>([]);

  const worktreeEnvTextRef = useRef(worktreeEnvText);
  useEffect(() => {
    worktreeEnvTextRef.current = worktreeEnvText;
  }, [worktreeEnvText]);

  const rawRepoEnvFileName = (repo as { env_file_name?: string }).env_file_name || '';
  const repoEnvFileName = rawRepoEnvFileName.trim() || '.env';
  const repoAutoWrite = !!(repo as { auto_write_env_file_on_create?: boolean })
    .auto_write_env_file_on_create;

  // Sync worktree env text when prop changes
  useEffect(() => {
    const nextEnvText = worktree.env_vars_text || '';
    setSavedWorktreeEnvText(nextEnvText);
    if (!isEditingWorktreeEnv) {
      setWorktreeEnvText(nextEnvText);
    }
  }, [worktree, isEditingWorktreeEnv]);

  // Listen for worktree patches to keep env text fresh (real-time updates)
  useEffect(() => {
    if (!client) return;

    const handleWorktreeUpdate = (data: unknown) => {
      const updatedWorktree = data as Worktree;
      if (updatedWorktree.worktree_id !== worktree.worktree_id) return;

      if (
        updatedWorktree.env_vars_text !== undefined &&
        updatedWorktree.env_vars_text !== worktreeEnvTextRef.current
      ) {
        setSavedWorktreeEnvText(updatedWorktree.env_vars_text);
        if (!isEditingWorktreeEnv) {
          setWorktreeEnvText(updatedWorktree.env_vars_text);
        }
      }
    };

    client.service('worktrees').on('patched', handleWorktreeUpdate);
    return () => client.service('worktrees').removeListener('patched', handleWorktreeUpdate);
  }, [client, worktree.worktree_id, isEditingWorktreeEnv]);

  const repoEnvKeys = useMemo(
    () => Object.keys((repo as { env_vars?: Record<string, string> }).env_vars || {}),
    [repo]
  );
  const worktreeEnvKeys = useMemo(() => Object.keys(worktree.env_vars || {}), [worktree.env_vars]);
  const hasStoredWorktreeEnv = useMemo(
    () => !!savedWorktreeEnvText.trim() || worktreeEnvKeys.length > 0,
    [savedWorktreeEnvText, worktreeEnvKeys]
  );

  // Load current user's user-repo env vars
  useEffect(() => {
    if (!client) return;

    const loadUserRepoEnv = async () => {
      setLoadingUserRepoEnv(true);
      try {
        const result = await client.service('user-repo-env-vars').find({
          query: { repo_id: repo.repo_id },
        });
        const list = Array.isArray(result) ? result : result?.data;
        const envMap = list?.[0]?.env_vars as Record<string, boolean> | undefined;
        setUserRepoEnvKeys(envMap ? Object.keys(envMap) : []);
      } catch (error) {
        console.error('Failed to load user-repo env vars for Env tab:', error);
        setUserRepoEnvKeys([]);
      } finally {
        setLoadingUserRepoEnv(false);
      }
    };

    loadUserRepoEnv();
  }, [client, repo.repo_id]);

  const handleSaveWorktreeEnv = async () => {
    if (!onUpdateWorktree) return;
    setSavingWorktreeEnv(true);
    try {
      await onUpdateWorktree(worktree.worktree_id, {
        env_vars_text: worktreeEnvText,
      });
      setSavedWorktreeEnvText(worktreeEnvText);
      setIsEditingWorktreeEnv(false);
      showSuccess('工作树环境变量已保存');
    } catch (error) {
      showError(
        error instanceof Error ? error.message : 'Failed to save worktree environment variables'
      );
    } finally {
      setSavingWorktreeEnv(false);
    }
  };

  const handleCancelWorktreeEnv = () => {
    setWorktreeEnvText(savedWorktreeEnvText);
    setIsEditingWorktreeEnv(false);
  };

  const handleClearWorktreeEnv = async () => {
    if (!onUpdateWorktree) return;

    setSavingWorktreeEnv(true);
    try {
      await onUpdateWorktree(worktree.worktree_id, { env_vars_text: '' });
      setWorktreeEnvText('');
      setSavedWorktreeEnvText('');
      showSuccess('已清空工作树环境变量');
    } catch (error) {
      showError(
        error instanceof Error ? error.message : 'Failed to clear worktree environment variables'
      );
    } finally {
      setSavingWorktreeEnv(false);
    }
  };

  const handleWriteEnvFile = async () => {
    if (!client) return;
    showSuccess('正在写入环境变量文件...');
    try {
      // Custom Feathers method: POST /worktrees/:id/write-env-file
      await client.service(`worktrees/${worktree.worktree_id}/write-env-file`).create({});
      showSuccess('已写入环境变量文件');
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Failed to write env file');
    }
  };

  return (
    <div style={{ padding: 16 }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Card
          title="Env 配置概览"
          size="small"
          styles={{ body: { padding: 12 } }}
          extra={
            <Space size={8}>
              <Tag icon={<FileTextOutlined />} color="blue">
                {repoEnvFileName}
              </Tag>
              {repoAutoWrite && <Tag color="green">自动写入</Tag>}
            </Space>
          }
        >
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Text type="secondary" style={{ width: 140 }}>
                仓库默认变量
              </Text>
              {repoEnvKeys.length === 0 ? (
                <Text type="secondary">未设置</Text>
              ) : (
                <Space size={[6, 6]} wrap>
                  {repoEnvKeys.map((key) => (
                    <Tag key={key} color="default">
                      {key}
                    </Tag>
                  ))}
                </Space>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Text type="secondary" style={{ width: 140 }}>
                用户仓库变量
              </Text>
              {loadingUserRepoEnv ? (
                <Text type="secondary">加载中...</Text>
              ) : userRepoEnvKeys.length === 0 ? (
                <Text type="secondary">未设置</Text>
              ) : (
                <Space size={[6, 6]} wrap>
                  {userRepoEnvKeys.map((key) => (
                    <Tag key={key} color="purple">
                      {key}
                    </Tag>
                  ))}
                </Space>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Text type="secondary" style={{ width: 140 }}>
                Worktree 已写变量
              </Text>
              {hasStoredWorktreeEnv ? (
                <Space size={[6, 6]} wrap>
                  {worktreeEnvKeys.length > 0 ? (
                    worktreeEnvKeys.map((key) => (
                      <Tag key={key} color="processing">
                        {key}
                      </Tag>
                    ))
                  ) : (
                    <Tag color="processing">已保存 .env 文本</Tag>
                  )}
                </Space>
              ) : (
                <Text type="secondary">暂无</Text>
              )}
            </div>
            <Divider style={{ margin: '8px 0' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              优先级：系统 &lt; 仓库默认 &lt; 用户全局 &lt; 用户-仓库 &lt; 工作树 .env。可点击下方写入按钮生成
              {repoEnvFileName} 文件。
            </Text>
          </Space>
        </Card>

        <Card
          title="Worktree Env (.env)"
          size="small"
          styles={{ body: { padding: 12 } }}
          extra={
            !isEditingWorktreeEnv && (
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                onClick={() => setIsEditingWorktreeEnv(true)}
              >
                编辑
              </Button>
            )
          }
        >
          <Text type="secondary" style={{ fontSize: 12 }}>
            仅作用于当前工作树，优先级高于用户级/仓库级变量。直接粘贴 .env 内容，一行一个 KEY=VALUE。
          </Text>

          {isEditingWorktreeEnv ? (
            <Space direction="vertical" size="small" style={{ width: '100%', marginTop: 8 }}>
              <TextArea
                value={worktreeEnvText}
                onChange={(e) => setWorktreeEnvText(e.target.value)}
                placeholder={
                  'DATABASE_URL=postgres://user:pass@localhost:5432/app\nREDIS_URL=redis://localhost:6379'
                }
                autoSize={{ minRows: 8, maxRows: 12 }}
                style={{
                  fontFamily: 'monospace',
                  fontSize: 11,
                  maxHeight: 320,
                  overflow: 'auto',
                  whiteSpace: 'pre',
                }}
              />

              <Space>
                <Button
                  type="primary"
                  size="small"
                  icon={<SaveOutlined />}
                  onClick={handleSaveWorktreeEnv}
                  loading={savingWorktreeEnv}
                >
                  保存环境变量
                </Button>
                <Button size="small" onClick={handleCancelWorktreeEnv} disabled={savingWorktreeEnv}>
                  取消
                </Button>
                <Button
                  danger
                  size="small"
                  icon={<DeleteOutlined />}
                  onClick={handleClearWorktreeEnv}
                  loading={savingWorktreeEnv}
                  disabled={!hasStoredWorktreeEnv && !worktreeEnvText.trim()}
                >
                  清空
                </Button>
              </Space>
            </Space>
          ) : (
            <div
              style={{
                width: '100%',
                marginTop: 8,
                padding: token.paddingSM,
                border: `1px solid ${token.colorBorder}`,
                borderRadius: token.borderRadius,
                background: token.colorBgContainer,
                maxHeight: 260,
                overflow: 'auto',
              }}
            >
              <Paragraph
                code
                style={{
                  fontSize: 11,
                  margin: 0,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  overflowWrap: 'break-word',
                }}
                copyable={worktreeEnvText ? { text: worktreeEnvText } : undefined}
              >
                {worktreeEnvText || '暂无工作树环境变量，点击右上角编辑以添加。'}
              </Paragraph>
            </div>
          )}
        </Card>

        <Card
          size="small"
          styles={{ body: { padding: 12 } }}
          title="一键写入 .env"
          extra={
            <Button type="primary" icon={<SaveOutlined />} onClick={handleWriteEnvFile}>
              写入环境变量文件
            </Button>
          }
        >
          <Text type="secondary" style={{ fontSize: 12 }}>
            将仓库默认 + 用户全局 + 用户-仓库 + 工作树 .env 合并后写入 {repoEnvFileName}。
          </Text>
        </Card>
      </Space>
    </div>
  );
};
