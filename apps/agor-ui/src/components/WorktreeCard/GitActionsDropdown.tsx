import type { AgorClient } from '@agor/core/api';
import type { Worktree } from '@agor/core/types';
import {
  BranchesOutlined,
  MergeCellsOutlined,
  PullRequestOutlined,
  RetweetOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Button, Dropdown, message } from 'antd';
import type React from 'react';
import { useState } from 'react';
import { CreatePRModal } from './modals/CreatePRModal';
import { MergeModal } from './modals/MergeModal';
import { RebaseModal } from './modals/RebaseModal';
import { RenameBranchModal } from './modals/RenameBranchModal';

interface GitActionsDropdownProps {
  worktree: Worktree;
  client: AgorClient | null;
  disabled?: boolean;
  onWorktreeUpdated?: () => void;
}

type ModalType = 'rebase' | 'merge' | 'rename' | 'create-pr' | null;

export const GitActionsDropdown: React.FC<GitActionsDropdownProps> = ({
  worktree,
  client,
  disabled,
  onWorktreeUpdated,
}) => {
  const [activeModal, setActiveModal] = useState<ModalType>(null);
  const [loading, setLoading] = useState(false);

  const handleRebase = async (onto: string) => {
    if (!client) return;
    setLoading(true);
    try {
      await client
        .service('worktrees/:id/git/rebase')
        .create({ onto }, { route: { id: worktree.worktree_id } });
      message.success(`Rebased onto ${onto}`);
      setActiveModal(null);
      onWorktreeUpdated?.();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Rebase failed');
    } finally {
      setLoading(false);
    }
  };

  const handleMerge = async (from: string) => {
    if (!client) return;
    setLoading(true);
    try {
      await client
        .service('worktrees/:id/git/merge')
        .create({ from }, { route: { id: worktree.worktree_id } });
      message.success(`Merged ${from}`);
      setActiveModal(null);
      onWorktreeUpdated?.();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Merge failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRename = async (newName: string) => {
    if (!client) return;
    setLoading(true);
    try {
      await client
        .service('worktrees/:id/git/rename-branch')
        .create({ newName }, { route: { id: worktree.worktree_id } });
      message.success(`Branch renamed to ${newName}`);
      setActiveModal(null);
      onWorktreeUpdated?.();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Rename failed');
    } finally {
      setLoading(false);
    }
  };

  const handleCreatePR = async (data: { title: string; body?: string; base?: string }) => {
    if (!client) return;
    setLoading(true);
    try {
      const result = (await client
        .service('worktrees/:id/git/create-pr')
        .create(data, { route: { id: worktree.worktree_id } })) as {
        prUrl?: string;
        prNumber?: number;
      };
      message.success(
        <span>
          PR created!{' '}
          {result.prUrl && (
            <a href={result.prUrl} target="_blank" rel="noopener noreferrer">
              #{result.prNumber}
            </a>
          )}
        </span>
      );
      setActiveModal(null);
      onWorktreeUpdated?.();
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Failed to create PR');
    } finally {
      setLoading(false);
    }
  };

  const menuItems: MenuProps['items'] = [
    {
      key: 'rebase',
      icon: <RetweetOutlined />,
      label: 'Rebase onto...',
      onClick: () => setActiveModal('rebase'),
    },
    {
      key: 'merge',
      icon: <MergeCellsOutlined />,
      label: 'Merge from...',
      onClick: () => setActiveModal('merge'),
    },
    {
      key: 'rename',
      icon: <BranchesOutlined />,
      label: 'Rename branch...',
      onClick: () => setActiveModal('rename'),
    },
    { type: 'divider' },
    {
      key: 'create-pr',
      icon: <PullRequestOutlined />,
      label: 'Create PR',
      onClick: () => setActiveModal('create-pr'),
    },
  ];

  return (
    <>
      <Dropdown menu={{ items: menuItems }} trigger={['click']} disabled={disabled || !client}>
        <Button
          type="text"
          size="small"
          icon={<BranchesOutlined />}
          title="Git actions (rebase, merge, rename, PR)"
          onClick={(e) => e.stopPropagation()}
        />
      </Dropdown>

      <RebaseModal
        open={activeModal === 'rebase'}
        worktree={worktree}
        client={client}
        loading={loading}
        onConfirm={handleRebase}
        onCancel={() => setActiveModal(null)}
      />

      <MergeModal
        open={activeModal === 'merge'}
        worktree={worktree}
        client={client}
        loading={loading}
        onConfirm={handleMerge}
        onCancel={() => setActiveModal(null)}
      />

      <RenameBranchModal
        open={activeModal === 'rename'}
        worktree={worktree}
        loading={loading}
        onConfirm={handleRename}
        onCancel={() => setActiveModal(null)}
      />

      <CreatePRModal
        open={activeModal === 'create-pr'}
        worktree={worktree}
        client={client}
        loading={loading}
        onConfirm={handleCreatePR}
        onCancel={() => setActiveModal(null)}
      />
    </>
  );
};
