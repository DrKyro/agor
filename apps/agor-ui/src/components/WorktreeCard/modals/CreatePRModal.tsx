import type { AgorClient } from '@agor/core/api';
import type { Worktree } from '@agor/core/types';
import { Form, Input, Modal, Select, Typography } from 'antd';
import type React from 'react';
import { useEffect, useState } from 'react';

interface CreatePRModalProps {
  open: boolean;
  worktree: Worktree;
  client: AgorClient | null;
  loading: boolean;
  onConfirm: (data: { title: string; body?: string; base?: string }) => void;
  onCancel: () => void;
}

export const CreatePRModal: React.FC<CreatePRModalProps> = ({
  open,
  worktree,
  client,
  loading,
  onConfirm,
  onCancel,
}) => {
  const [form] = Form.useForm();
  const [branches, setBranches] = useState<string[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);

  useEffect(() => {
    if (open && client) {
      // Reset form with default values
      form.setFieldsValue({
        title: worktree.ref,
        body: '',
        base: worktree.base_ref || 'main',
      });

      // Load branches
      setLoadingBranches(true);
      client
        .service('worktrees/:id/git/branches')
        .find({ route: { id: worktree.worktree_id } })
        .then((result: { remote: string[] }) => {
          setBranches(result.remote);
        })
        .catch(console.error)
        .finally(() => setLoadingBranches(false));
    }
  }, [open, client, worktree, form]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      onConfirm(values);
    } catch {
      // Form validation failed
    }
  };

  return (
    <Modal
      title="Create Pull Request"
      open={open}
      onOk={handleOk}
      onCancel={onCancel}
      confirmLoading={loading}
      width={520}
    >
      <Typography.Paragraph type="secondary">
        Create a PR for <strong>{worktree.ref}</strong>
      </Typography.Paragraph>

      <Form form={form} layout="vertical">
        <Form.Item
          name="title"
          label="Title"
          rules={[{ required: true, message: 'Title is required' }]}
        >
          <Input placeholder="PR title" />
        </Form.Item>

        <Form.Item name="body" label="Description">
          <Input.TextArea rows={4} placeholder="Describe your changes..." />
        </Form.Item>

        <Form.Item name="base" label="Base branch">
          <Select
            placeholder="Select base branch"
            loading={loadingBranches}
            options={branches.map((b) => ({ label: b, value: b }))}
            showSearch
            filterOption={(input, option) =>
              (option?.label as string)?.toLowerCase().includes(input.toLowerCase())
            }
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};
