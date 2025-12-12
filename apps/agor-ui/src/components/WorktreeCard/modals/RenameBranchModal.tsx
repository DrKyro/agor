import type { Worktree } from '@agor/core/types';
import { Input, Modal, Typography } from 'antd';
import type React from 'react';
import { useEffect, useState } from 'react';

interface RenameBranchModalProps {
  open: boolean;
  worktree: Worktree;
  loading: boolean;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
}

export const RenameBranchModal: React.FC<RenameBranchModalProps> = ({
  open,
  worktree,
  loading,
  onConfirm,
  onCancel,
}) => {
  const [newName, setNewName] = useState('');

  useEffect(() => {
    if (open) {
      setNewName(worktree.ref);
    }
  }, [open, worktree.ref]);

  const isValid = newName.trim() !== '' && /^[a-zA-Z0-9._/-]+$/.test(newName);

  return (
    <Modal
      title="Rename Branch"
      open={open}
      onOk={() => isValid && onConfirm(newName)}
      onCancel={onCancel}
      confirmLoading={loading}
      okButtonProps={{ disabled: !isValid || newName === worktree.ref }}
    >
      <Typography.Paragraph type="secondary">
        Rename branch from <strong>{worktree.ref}</strong> to:
      </Typography.Paragraph>
      <Input
        placeholder="New branch name"
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        status={newName && !isValid ? 'error' : undefined}
      />
      {newName && !isValid && (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          Branch name can only contain letters, numbers, dots, underscores, slashes, and hyphens
        </Typography.Text>
      )}
    </Modal>
  );
};
