import { DeleteOutlined, PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { Button, Divider, Input, Space, Table, Tag, Typography, Upload } from 'antd';
import type { RcFile } from 'antd/es/upload';
import { useState } from 'react';
import { useThemedMessage } from '@/utils/message';

const { Text } = Typography;
const { TextArea } = Input;

export interface EnvVarEditorProps {
  /** Current env vars (key → isSet boolean) */
  envVars: Record<string, boolean>;
  /** Callback when user adds/updates a variable */
  onSave: (key: string, value: string) => Promise<void>;
  /** Callback when user deletes a variable */
  onDelete: (key: string) => Promise<void>;
  /** Loading state for operations */
  loading?: Record<string, boolean>;
  /** Disable all fields */
  disabled?: boolean;
}

export const EnvVarEditor: React.FC<EnvVarEditorProps> = ({
  envVars,
  onSave,
  onDelete,
  loading = {},
  disabled = false,
}) => {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const { showSuccess, showError, showWarning } = useThemedMessage();

  type ParsedVar = { key: string; value: string };

  const parseEnvText = (text: string): { entries: ParsedVar[]; skipped: number } => {
    const lines = text.split(/\r?\n/);
    const result = new Map<string, string>();
    let skipped = 0;

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      const withoutExport = trimmed.startsWith('export ')
        ? trimmed.slice('export '.length).trim()
        : trimmed;
      const equalsIndex = withoutExport.indexOf('=');
      if (equalsIndex <= 0) {
        skipped += 1;
        return;
      }

      const key = withoutExport.slice(0, equalsIndex).trim();
      const rawValue = withoutExport.slice(equalsIndex + 1).trim();
      if (!key || !rawValue) {
        skipped += 1;
        return;
      }

      const unquotedValue =
        (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))
          ? rawValue.slice(1, -1)
          : rawValue;

      result.set(key, unquotedValue.trim());
    });

    const entries = Array.from(result.entries())
      .filter(([, value]) => value.length > 0)
      .map(([key, value]) => ({ key, value }));

    return { entries, skipped };
  };

  const processImport = async (
    entries: ParsedVar[],
    skipped: number,
    sourceLabel: string
  ): Promise<boolean> => {
    if (entries.length === 0) {
      setError('No valid KEY=VALUE lines found to import');
      return false;
    }

    setError(null);
    setImporting(true);
    const failedKeys: string[] = [];

    for (const { key, value } of entries) {
      try {
        await onSave(key, value);
      } catch (err) {
        console.error(`Failed to import ${key} from ${sourceLabel}:`, err);
        failedKeys.push(key);
      }
    }

    setImporting(false);

    const skippedText = skipped > 0 ? `; skipped ${skipped} invalid line(s)` : '';

    if (failedKeys.length === 0) {
      showSuccess(`Imported ${entries.length} variables from ${sourceLabel}${skippedText}`);
      return true;
    }

    const failedList = failedKeys.join(', ');
    const successCount = entries.length - failedKeys.length;
    showWarning(
      `Imported ${successCount}/${entries.length} variables from ${sourceLabel}${skippedText}; failed: ${failedList}`
    );
    setError(`Failed to import: ${failedList}`);
    return false;
  };

  const handleImportText = async () => {
    if (!importText.trim()) {
      setError('Paste env vars (one KEY=VALUE per line) before importing');
      return;
    }
    const { entries, skipped } = parseEnvText(importText);
    const succeeded = await processImport(entries, skipped, 'pasted text');
    if (succeeded) {
      setImportText('');
    }
  };

  const handleFileUpload = async (file: RcFile) => {
    try {
      const fileText = await file.text();
      const { entries, skipped } = parseEnvText(fileText);
      await processImport(entries, skipped, file.name || 'uploaded file');
    } catch (err) {
      console.error('Failed to read uploaded env file:', err);
      showError('Failed to read uploaded env file');
      setError('Failed to read uploaded env file');
    }
    return false;
  };

  const handleAdd = async () => {
    if (!newKey.trim() || !newValue.trim()) return;

    try {
      setError(null);
      await onSave(newKey.trim(), newValue.trim());
      setNewKey('');
      setNewValue('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save environment variable';
      setError(message);
    }
  };

  const handleUpdate = async (key: string) => {
    if (!editingValue.trim()) return;

    try {
      setError(null);
      await onSave(key, editingValue.trim());
      setEditingKey(null);
      setEditingValue('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update environment variable';
      setError(message);
    }
  };

  const handleDeleteClick = async (key: string) => {
    try {
      setError(null);
      await onDelete(key);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete environment variable';
      setError(message);
    }
  };

  const columns = [
    {
      title: 'Variable Name',
      dataIndex: 'key',
      key: 'key',
      width: '30%',
      render: (key: string) => <code>{key}</code>,
    },
    {
      title: 'Value',
      dataIndex: 'isSet',
      key: 'value',
      width: '40%',
      render: (isSet: boolean, record: { key: string }) => {
        const isEditing = editingKey === record.key;

        if (isEditing) {
          return (
            <Space.Compact style={{ width: '100%' }}>
              <Input.Password
                placeholder="Enter new value"
                value={editingValue}
                onChange={(e) => setEditingValue(e.target.value)}
                onPressEnter={() => handleUpdate(record.key)}
                autoFocus
                disabled={disabled || importing}
              />
              <Button
                type="primary"
                onClick={() => handleUpdate(record.key)}
                loading={loading[record.key]}
                disabled={disabled || importing || !editingValue.trim()}
              >
                Save
              </Button>
              <Button onClick={() => setEditingKey(null)} disabled={disabled || importing}>
                Cancel
              </Button>
            </Space.Compact>
          );
        }

        return (
          <Space>
            <Tag color={isSet ? 'success' : 'default'}>{isSet ? 'Set (encrypted)' : 'Not Set'}</Tag>
            {isSet && (
              <Button
                type="link"
                size="small"
                onClick={() => {
                  setEditingKey(record.key);
                  setEditingValue('');
                }}
                disabled={disabled || importing}
              >
                Update
              </Button>
            )}
          </Space>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: '30%',
      render: (_: unknown, record: { key: string }) => (
        <Button
          danger
          icon={<DeleteOutlined />}
          onClick={() => handleDeleteClick(record.key)}
          loading={loading[record.key]}
          disabled={disabled || importing}
        >
          Delete
        </Button>
      ),
    },
  ];

  const dataSource = Object.entries(envVars).map(([key, isSet]) => ({
    key,
    isSet,
  }));

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Text type="secondary">
        Environment variables are encrypted at rest and available to all agent operations
        (subprocesses, terminal sessions, environment commands). Common variables: GITHUB_TOKEN,
        NPM_TOKEN, AWS_ACCESS_KEY_ID, etc.
      </Text>

      {error && (
        <div
          style={{ color: '#ff4d4f', padding: '8px', borderRadius: '4px', background: '#fff1f0' }}
        >
          <Text type="danger">{error}</Text>
        </div>
      )}

      {/* Existing Variables Table */}
      <Table
        columns={columns}
        dataSource={dataSource}
        pagination={false}
        size="small"
        locale={{ emptyText: 'No environment variables configured' }}
        style={{ width: '100%' }}
      />

      {/* Add New Variable Form */}
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Text strong>Add New Variable</Text>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            placeholder="Variable name (e.g., GITHUB_TOKEN)"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            onPressEnter={handleAdd}
            style={{ width: '30%' }}
            disabled={disabled || importing}
          />
          <Input.Password
            placeholder="Value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            onPressEnter={handleAdd}
            style={{ flex: 1 }}
            disabled={disabled || importing}
          />
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleAdd}
            disabled={disabled || importing || !newKey.trim() || !newValue.trim()}
          >
            Add
          </Button>
        </Space.Compact>
      </Space>

      <Divider style={{ margin: '8px 0' }} />

      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Text strong>Import from .env or text</Text>
        <Text type="secondary">
          Upload a .env file or paste KEY=VALUE lines (one per line) to import multiple variables.
          Existing keys will be overwritten.
        </Text>
        <Space wrap>
          <Upload
            accept=".env,text/plain"
            showUploadList={false}
            beforeUpload={handleFileUpload}
            disabled={disabled || importing}
          >
            <Button icon={<UploadOutlined />} disabled={disabled || importing}>
              Upload .env
            </Button>
          </Upload>
          <Button
            type="primary"
            onClick={handleImportText}
            disabled={disabled || importing || !importText.trim()}
          >
            Import from text
          </Button>
        </Space>
        <TextArea
          placeholder={'API_KEY=123\nDATABASE_URL=postgres://user:pass@localhost:5432/db'}
          rows={4}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          disabled={disabled || importing}
          style={{ fontFamily: 'monospace' }}
        />
      </Space>
    </Space>
  );
};
