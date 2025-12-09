/**
 * Diff Tab Component
 *
 * Main tab for displaying git diff between worktree branches
 */

import type { AgorClient } from '@agor/core/api';
import type { AvailableRefs, GitDiffFile, Repo, Worktree } from '@agor/core/types';
import { Col, message, Row } from 'antd';
import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import DiffControls from '@/components/DiffControls/DiffControls';
import DiffViewer from '@/components/DiffViewer/DiffViewer';

interface DiffTabProps {
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

export const DiffTab: React.FC<DiffTabProps> = ({ worktree, repo, client }) => {
  const [state, setState] = useState<DiffState>({
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
   * Generate simple diff output from file list
   * In a real implementation, this would come from the API
   */
  const generateDiffOutput = useCallback((files: GitDiffFile[]): string => {
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
  }, []);

  /**
   * Load diff from the API
   */
  const loadDiff = useCallback(
    async (from?: string, to?: string) => {
      setState((prev) => ({ ...prev, loading: true, error: null }));

      try {
        // Call nested worktrees diff service with route params
        const result = (await client!.service('worktrees/:id/diff').find({
          route: { id: worktree.worktree_id },
          query: {
            from: from || state.fromRef,
            to: to || state.toRef,
          },
        })) as unknown as {
          diff: {
            files: GitDiffFile[];
            summary: {
              total: number;
              additions: number;
              deletions: number;
            };
          };
          diffOutput?: string;
          availableRefs?: AvailableRefs;
        };

        // Get diff output for display
        // We need to call a different endpoint or method to get the raw diff
        // For now, we'll create a simple text representation
        const diffOutput = result.diffOutput || generateDiffOutput(result.diff.files);

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
        message.error(`Failed to load diff: ${errorMessage}`);
      }
    },
    [client, worktree.worktree_id, state.fromRef, state.toRef, generateDiffOutput]
  );

  /**
   * Initial load
   */
  useEffect(() => {
    loadDiff();
  }, [loadDiff]);

  // Early return for client check (must be after hooks to follow Rules of Hooks)
  if (!client) {
    return <div className="p-4">Client not available</div>;
  }

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

  return (
    <div style={{ padding: '16px' }}>
      <Row gutter={16}>
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
            style={{ height: 'calc(100vh - 400px)' }}
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
  );
};

export default DiffTab;
