import type { AgorClient } from '@agor/core/api';
import type {
  AgenticToolName,
  PermissionMode,
  Repo,
  RepoGitInfo,
  User,
  UUID,
} from '@agor/core/types';
import { getDefaultPermissionMode } from '@agor/core/types';
import { LoadingOutlined } from '@ant-design/icons';
import { Form, Input, Modal, Select, Typography } from 'antd';
import type { FormInstance } from 'antd/es/form';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AgenticToolOption } from '../../types';
import { AutocompleteTextarea } from '../AutocompleteTextarea';

export interface QuickTaskFormValues {
  repo_id: UUID;
  base_branch: string;
  agent: AgenticToolName;
  permissionMode: PermissionMode;
  prompt: string;
}

interface QuickTaskModalProps {
  open: boolean;
  repos: Repo[];
  availableAgents: AgenticToolOption[];
  client: AgorClient | null;
  userById: Map<string, User>;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (values: QuickTaskFormValues) => Promise<void>;
}

const permissionOptions: Array<{ value: PermissionMode; label: string }> = [
  { value: 'acceptEdits', label: 'Accept Edits (auto-apply safe changes)' },
  { value: 'ask', label: 'Ask for Approval (review every action)' },
  { value: 'auto', label: 'Auto (optimize for speed)' },
  { value: 'bypassPermissions', label: 'Full Auto (no prompts)' },
];

export const QuickTaskModal: React.FC<QuickTaskModalProps> = ({
  open,
  repos,
  availableAgents,
  client,
  userById,
  submitting,
  onClose,
  onSubmit,
}) => {
  const [form] = Form.useForm<QuickTaskFormValues>();
  const [branchHint, setBranchHint] = useState<string | null>(null);
  const [branchLoading, setBranchLoading] = useState(false);
  const pendingRepoId = useRef<string | null>(null);
  const permissionTouchedRef = useRef(false);

  const defaultAgentId =
    availableAgents.find((agent) => !agent.beta)?.id || availableAgents[0]?.id || 'claude-code';

  const repoOptions = useMemo(
    () =>
      [...repos]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((repo) => ({
          label: repo.name || repo.slug,
          value: repo.repo_id,
          description: repo.slug,
        })),
    [repos]
  );

  const handleRepoChange = useCallback(
    async (repoId: string, formInstance: FormInstance<QuickTaskFormValues>) => {
      const fallbackRepo = repos.find((r) => r.repo_id === repoId);
      if (fallbackRepo) {
        const fallback = fallbackRepo.default_branch || 'dev';
        formInstance.setFieldValue('base_branch', fallback);
        setBranchHint(`Default branch: ${fallback}`);
      } else {
        formInstance.setFieldValue('base_branch', 'dev');
        setBranchHint('Default branch: dev');
      }

      if (!client) {
        return;
      }

      pendingRepoId.current = repoId;
      setBranchLoading(true);

      try {
        const result = await client.service('git-info').find({
          query: { repo_id: repoId },
        });

        const infoArray = Array.isArray(result)
          ? (result as RepoGitInfo[])
          : ((result as { data?: RepoGitInfo[] })?.data ?? []);
        const info = infoArray[0];

        if (info && pendingRepoId.current === repoId) {
          formInstance.setFieldValue('base_branch', info.currentBranch);
          setBranchHint(
            info.currentBranch === info.defaultBranch
              ? `Auto-detected default branch (${info.currentBranch})`
              : `Auto-detected HEAD (${info.currentBranch})`
          );
        }
      } catch (error) {
        if (pendingRepoId.current === repoId) {
          setBranchHint('Using fallback branch');
        }
        console.error('Failed to load git info:', error);
      } finally {
        if (pendingRepoId.current === repoId) {
          setBranchLoading(false);
        }
      }
    },
    [client, repos]
  );

  const resetForm = useCallback(() => {
    form.resetFields();
    setBranchHint(null);
    setBranchLoading(false);
    pendingRepoId.current = null;
    permissionTouchedRef.current = false;
  }, [form]);

  useEffect(() => {
    if (!open) {
      resetForm();
      return;
    }

    const defaultRepoId = repos[0]?.repo_id;
    form.setFieldsValue({
      repo_id: defaultRepoId,
      base_branch: repos[0]?.default_branch || 'dev',
      agent: (defaultAgentId as AgenticToolName) ?? 'claude-code',
      permissionMode: getDefaultPermissionMode(
        (defaultAgentId as AgenticToolName) ?? 'claude-code'
      ),
      prompt: '',
    });

    if (defaultRepoId) {
      handleRepoChange(defaultRepoId, form);
    } else {
      setBranchHint('Create a repository to get started');
    }
  }, [open, repos, form, defaultAgentId, handleRepoChange, resetForm]);

  const handleValuesChange = useCallback(
    (changedValues: Partial<QuickTaskFormValues>) => {
      if (typeof changedValues.repo_id === 'string') {
        handleRepoChange(changedValues.repo_id, form);
      }

      if (typeof changedValues.permissionMode !== 'undefined') {
        permissionTouchedRef.current = true;
      }

      if (typeof changedValues.agent === 'string') {
        permissionTouchedRef.current = false;
        const nextMode = getDefaultPermissionMode(changedValues.agent as AgenticToolName);
        form.setFieldValue('permissionMode', nextMode);
      }
    },
    [form, handleRepoChange]
  );

  const agentSelectOptions = useMemo(
    () =>
      availableAgents.map((agent) => ({
        value: agent.id,
        label: agent.name,
      })),
    [availableAgents]
  );

  const handleSubmit = () => {
    form
      .validateFields()
      .then((values) => onSubmit(values))
      .catch(() => {
        /* validation errors */
      });
  };

  return (
    <Modal
      title="Quick Task"
      open={open}
      onCancel={onClose}
      onOk={handleSubmit}
      okText="Create & Execute"
      okButtonProps={{
        disabled: repos.length === 0 || !client,
        loading: submitting,
      }}
      cancelButtonProps={{ disabled: submitting }}
      width={600}
      destroyOnClose
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 24 }}>
        Fill out the task details below to create a dedicated worktree, start a session, and trigger
        the first prompt automatically.
      </Typography.Paragraph>

      <Form layout="vertical" form={form} onValuesChange={handleValuesChange} preserve={false}>
        <Form.Item
          label="Repository"
          name="repo_id"
          rules={[{ required: true, message: 'Select a repository' }]}
        >
          <Select
            placeholder="Select repository"
            options={repoOptions}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>

        <Form.Item
          label="Base Branch"
          name="base_branch"
          rules={[{ required: true, message: 'Enter base branch' }]}
          extra={branchHint || undefined}
        >
          <Input
            placeholder="dev"
            suffix={branchLoading ? <LoadingOutlined /> : null}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </Form.Item>

        <Form.Item
          label="AI Agent"
          name="agent"
          rules={[{ required: true, message: 'Select an agent' }]}
        >
          <Select
            placeholder="Select agent"
            options={agentSelectOptions}
            optionFilterProp="label"
          />
        </Form.Item>

        <Form.Item
          label="Permission Level"
          name="permissionMode"
          rules={[{ required: true, message: 'Select a permission mode' }]}
        >
          <Select
            placeholder="Choose how aggressive the agent should be"
            options={permissionOptions}
          />
        </Form.Item>

        <Form.Item
          label="Task"
          name="prompt"
          rules={[{ required: true, message: 'Describe the task' }]}
        >
          <AutocompleteTextarea
            value={form.getFieldValue('prompt') || ''}
            onChange={(value) => form.setFieldValue('prompt', value)}
            placeholder="Describe the task, attach files, or paste screenshots..."
            autoSize={{ minRows: 5, maxRows: 8 }}
            client={client}
            sessionId={null}
            userById={userById}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
};
