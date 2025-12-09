/**
 * Standalone Diff Page
 *
 * Full-page view for git diff between worktree branches
 */

import type { AgorClient } from '@agor/core/api';
import type { AvailableRefs, GitDiffFile, Repo, Worktree } from '@agor/core/types';
import { LeftOutlined, BranchesOutlined } from '@ant-design/icons';
import { Col, Row } from 'antd';
import type React from 'react';
import { useNavigate } from 'react-router-dom';
import DiffControls from '@/components/DiffControls/DiffControls';
import DiffViewer from '@/components/DiffViewer/DiffViewer';
import { Button } from 'antd';
import { Typography, theme } from 'antd';

interface DiffPageProps {
  worktree: Worktree;
  repo: Repo;
  client: AgorClient | null;
}

interface DiffState {
  fromRef: string;
  toRef: string;
  files: GitDiffFile[];
  summary?: {
    total: number;
    additions: number;
    deletions: number;
  };
  diffOutput: string;
  availableRefs?: AvailableRefs;
  loading: boolean;
  error: string | null;
}

export const DiffPage: React.FC<DiffPageProps> = ({ worktree, repo, client }) => {
  const navigate = useNavigate();
  const { token } = theme.useToken();
  const [state, setState] = React.useState<DiffState>({
    fromRef: worktree.base_ref || 'HEAD',
    toRef: worktree.ref,
    files: [],
    summary: undefined,
    diffOutput: '',
    availableRefs: undefined,
    loading: false,
    error: null,
  });

  /**
   * Load diff from the API
   */
  const loadDiff = React.useCallback(async (from?: string, to?: string) => {
    if (!client) {
      setState((prev) => ({ ...prev, error: 'No client available', loading: false }));
      return;
    }

    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const result = (await client.service(`worktrees/${worktree.worktree_id}/diff`).find({
        query: {
          from: from || state.fromRef,
          to: to || state.toRef,
        },
      })) as {
        diff: {
          files: GitDiffFile[];
          summary: {
            total: number;
            additions: number;
            deletions: number;
          };
        };
        availableRefs?: AvailableRefs;
      };

      const diffOutput = generateDiffOutput(result.diff.files);

      setState((prev) => ({
        ...prev,
        fromRef: from || prev.fromRef,
        toRef: to || prev.toRef,
        files: result.diff.files,
        summary: result.diff.summary,
        diffOutput,
        availableRefs: result.availableRefs,
        loading: false,
        error: null,
      }));
    } catch (error) {
      console.error('Failed to load diff:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to load diff';
      setState((prev) => ({
        ...prev,
        loading: false,
        error: errorMessage,
      }));
    }
  }, [client, worktree.worktree_id, state.fromRef, state.toRef]);

  /**
   * Generate simple diff output from file list
   */
  const generateDiffOutput = (files: GitDiffFile[]): string => {
    if (files.length === 0) {
      return 'No differences found';
    }

    let output = '';
    for (const file of files) {
      output += `diff --git a/${file.path} b/${file.path}\n`;
      output += `index 0000000..0000000 ${file.isBinary ? '100644' : '100644'}\n`;

      if (file.status === 'added') {
        output += `--- /dev/null\n`;
        output += `+++ b/${file.path}\n`;
        output += `@@ -0,0 +1,${file.additions}\n`;
        for (let i = 0; i < file.additions; i++) {
          output += `+Line ${i + 1} (added)\n`;
        }
      } else if (file.status === 'deleted') {
        output += `--- a/${file.path}\n`;
        output += `+++ /dev/null\n`;
        output += `@@ -1,${file.deletions} +0,0\n`;
        for (let i = 0; i < file.deletions; i++) {
          output += `-Line ${i + 1} (deleted)\n`;
        }
      } else {
        output += `--- a/${file.path}\n`;
        output += `+++ b/${file.path}\n`;
        output += `@@ -1,${file.deletions} +1,${file.additions}\n`;
        for (let i = 0; i < file.additions; i++) {
          output += `+Line ${i + 1} (added)\n`;
        }
        for (let i = 0; i < file.deletions; i++) {
          output += `-Line ${i + 1} (deleted)\n`;
        }
      }
      output += '\n';
    }

    return output;
  };

  /**
   * Handle ref change
   */
  const handleRefChange = (from: string, to: string) => {
    loadDiff(from, to);
  };

  /**
   * Handle refresh
   */
  const handleRefresh = () => {
    loadDiff();
  };

  /**
   * Initial load
   */
  React.useEffect(() => {
    loadDiff();
  }, [loadDiff, worktree.worktree_id]);

  if (!client) {
    return (
      <div style={{ padding: '24px' }}>
        <Typography.Text>Client not available</Typography.Text>
      </div>
    );
  }

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: token.colorBgContainer,
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '16px 24px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          display: 'flex',
          alignItems: 'center',
          gap: '16px',
        }}
      >
        <Button
          type="text"
          icon={<LeftOutlined />}
          onClick={() => navigate(-1)}
        >
          Back
        </Button>
        <BranchesOutlined style={{ fontSize: '20px', color: token.colorPrimary }} />
        <div>
          <Typography.Title level={4} style={{ margin: 0 }}>
            Git Diff
          </Typography.Title>
          <Typography.Text type="secondary">
            {repo.slug} / {worktree.name}
          </Typography.Text>
        </div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'hidden', padding: '16px 24px' }}>
        <Row gutter={16} style={{ height: '100%' }}>
          {/* Left sidebar - Controls */}
          <Col span={8}>
            <DiffControls
              worktreeRef={worktree.ref}
              worktreeBaseRef={worktree.base_ref}
              availableRefs={state.availableRefs}
              files={state.files}
              summary={state.summary}
              onRefresh={handleRefresh}
              onRefChange={handleRefChange}
              loading={state.loading}
            />
          </Col>

          {/* Right main area - Diff Viewer */}
          <Col span={16}>
            <div
              className="border rounded-lg overflow-hidden"
              style={{ height: '100%' }}
            >
              <DiffViewer
                diffOutput={state.diffOutput}
                files={state.files}
                loading={state.loading}
                error={state.error}
              />
            </div>
          </Col>
        </Row>
      </div>
    </div>
  );
};

export default DiffPage;
