import type { AgorClient } from '@agor/core/api';
import type { Worktree } from '@agor/core/types';
import { Modal, Select, Typography } from 'antd';
import type React from 'react';
import { useEffect, useState } from 'react';

interface MergeModalProps {
  open: boolean;
  worktree: Worktree;
  client: AgorClient | null;
  loading: boolean;
  onConfirm: (from: string) => void;
  onCancel: () => void;
}

export const MergeModal: React.FC<MergeModalProps> = ({
  open,
  worktree,
  client,
  loading,
  onConfirm,
  onCancel,
}) => {
  const [branches, setBranches] = useState<string[]>([]);
  const [selectedBranch, setSelectedBranch] = useState<string>('');
  const [loadingBranches, setLoadingBranches] = useState(false);

  useEffect(() => {
    if (open && client) {
      setLoadingBranches(true);
      client
        .service('worktrees/:id/git/branches')
        .find({ route: { id: worktree.worktree_id } })
        .then((result: { remote: string[]; current?: string }) => {
          setBranches(result.remote);
          // Default to base_ref or main
          const defaultBranch = worktree.base_ref || 'main';
          setSelectedBranch(
            result.remote.includes(defaultBranch) ? defaultBranch : result.remote[0] || ''
          );
        })
        .catch(console.error)
        .finally(() => setLoadingBranches(false));
    }
  }, [open, client, worktree]);

  return (
    <Modal
      title="Merge Branch"
      open={open}
      onOk={() => selectedBranch && onConfirm(selectedBranch)}
      onCancel={onCancel}
      confirmLoading={loading}
      okButtonProps={{ disabled: !selectedBranch }}
    >
      <Typography.Paragraph type="secondary">
        Merge into <strong>{worktree.ref}</strong> from:
      </Typography.Paragraph>
      <Select
        style={{ width: '100%' }}
        placeholder="Select source branch"
        value={selectedBranch || undefined}
        onChange={setSelectedBranch}
        loading={loadingBranches}
        options={branches.map((b) => ({ label: b, value: b }))}
        showSearch
        filterOption={(input, option) =>
          (option?.label as string)?.toLowerCase().includes(input.toLowerCase())
        }
      />
    </Modal>
  );
};
