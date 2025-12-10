/**
 * Diff Controls Component
 *
 * Provides controls for selecting diff parameters (from/to refs, filters, search)
 */

import type { AvailableRefs, GitDiffFile } from '@agor/core/types';
import { FilterOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons';
import { Button, Card, Input, Select, Space, Statistic, Tooltip } from 'antd';
import type React from 'react';
import { useEffect, useState } from 'react';

const { Option } = Select;

interface DiffControlsProps {
  worktreeRef: string;
  worktreeBaseRef?: string;
  availableRefs?: AvailableRefs;
  files?: GitDiffFile[];
  summary?: {
    total: number;
    additions: number;
    deletions: number;
  };
  onRefresh?: () => void;
  onRefChange?: (from: string, to: string) => void;
  onSearch?: (query: string) => void;
  onFilter?: (filter: { filePattern?: string; status?: string[] }) => void;
  loading?: boolean;
}

export const DiffControls: React.FC<DiffControlsProps> = ({
  worktreeRef,
  worktreeBaseRef,
  availableRefs,
  files = [],
  summary,
  onRefresh,
  onRefChange,
  onSearch,
  onFilter,
  loading = false,
}) => {
  const [fromRef, setFromRef] = useState<string>(worktreeBaseRef || 'HEAD');
  const [toRef, setToRef] = useState<string>(worktreeRef);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filePattern, setFilePattern] = useState<string>('');

  // Update refs when props change
  useEffect(() => {
    setFromRef(worktreeBaseRef || 'HEAD');
    setToRef(worktreeRef);
  }, [worktreeRef, worktreeBaseRef]);

  const handleRefChange = () => {
    if (onRefChange) {
      onRefChange(fromRef, toRef);
    }
  };

  const handleSearch = (value: string) => {
    if (onSearch) {
      onSearch(value);
    }
  };

  const handleFilter = () => {
    if (onFilter) {
      onFilter({ filePattern: filePattern || undefined });
    }
  };

  const handleClearFilter = () => {
    setFilePattern('');
    setSearchQuery('');
    if (onFilter) {
      onFilter({});
    }
    if (onSearch) {
      onSearch('');
    }
  };

  return (
    <div className="space-y-4">
      {/* Summary Statistics */}
      {summary && (
        <Card size="small">
          <div className="grid grid-cols-3 gap-4">
            <Statistic
              title="Files Changed"
              value={summary.total}
              valueStyle={{ fontSize: '1.2rem' }}
            />
            <Statistic
              title="Additions"
              value={summary.additions}
              valueStyle={{ fontSize: '1.2rem', color: '#3f8600' }}
            />
            <Statistic
              title="Deletions"
              value={summary.deletions}
              valueStyle={{ fontSize: '1.2rem', color: '#cf1322' }}
            />
          </div>
        </Card>
      )}

      {/* Controls */}
      <Card size="small" title="Diff Settings">
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {/* Ref Selectors */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="block text-sm font-medium text-gray-700 mb-1">From (Original)</div>
              <Select
                value={fromRef}
                onChange={setFromRef}
                style={{ width: '100%' }}
                placeholder="Select ref"
              >
                {/* Default options */}
                <Option value="HEAD">HEAD</Option>
                {worktreeBaseRef && worktreeBaseRef !== 'HEAD' && (
                  <Option value={worktreeBaseRef}>{worktreeBaseRef} (Base)</Option>
                )}

                {/* Branches */}
                {availableRefs?.branches.map((branch) => (
                  <Option key={`branch-${branch}`} value={branch}>
                    📁 {branch}
                  </Option>
                ))}

                {/* Tags */}
                {availableRefs?.tags.map((tag) => (
                  <Option key={`tag-${tag}`} value={tag}>
                    🏷️ {tag}
                  </Option>
                ))}
              </Select>
            </div>

            <div>
              <div className="block text-sm font-medium text-gray-700 mb-1">To (Compare)</div>
              <Select
                value={toRef}
                onChange={setToRef}
                style={{ width: '100%' }}
                placeholder="Select ref"
              >
                <Option value={worktreeRef}>📂 {worktreeRef} (Current)</Option>

                {/* Branches */}
                {availableRefs?.branches.map((branch) => (
                  <Option key={`branch-${branch}`} value={branch}>
                    📁 {branch}
                  </Option>
                ))}

                {/* Tags */}
                {availableRefs?.tags.map((tag) => (
                  <Option key={`tag-${tag}`} value={tag}>
                    🏷️ {tag}
                  </Option>
                ))}
              </Select>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-2">
            <Button
              type="primary"
              icon={<ReloadOutlined />}
              onClick={handleRefChange}
              loading={loading}
            >
              Update Diff
            </Button>

            <Tooltip title="Refresh diff">
              <Button icon={<ReloadOutlined />} onClick={onRefresh} loading={loading} />
            </Tooltip>
          </div>
        </Space>
      </Card>

      {/* Filters */}
      <Card
        size="small"
        title={
          <Space>
            <FilterOutlined />
            Filters
          </Space>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {/* Search */}
          <div>
            <div className="block text-sm font-medium text-gray-700 mb-1">Search</div>
            <Space.Compact style={{ width: '100%' }}>
              <Input
                aria-label="Search diff content"
                placeholder="Search in diff content"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onPressEnter={() => handleSearch(searchQuery)}
              />
              <Button icon={<SearchOutlined />} onClick={() => handleSearch(searchQuery)} />
            </Space.Compact>
          </div>

          {/* File Pattern Filter */}
          <div>
            <div className="block text-sm font-medium text-gray-700 mb-1">File Pattern</div>
            <Input
              aria-label="File pattern"
              placeholder="e.g., *.ts, src/**/*.tsx"
              value={filePattern}
              onChange={(e) => setFilePattern(e.target.value)}
              onPressEnter={handleFilter}
              suffix={
                <Tooltip title="Apply filter">
                  <Button
                    type="text"
                    size="small"
                    icon={<FilterOutlined />}
                    onClick={handleFilter}
                  />
                </Tooltip>
              }
            />
          </div>

          {/* Clear Filters */}
          {(searchQuery || filePattern) && (
            <Button type="link" onClick={handleClearFilter}>
              Clear all filters
            </Button>
          )}
        </Space>
      </Card>

      {/* Files List */}
      {files.length > 0 && (
        <Card size="small" title={`Changed Files (${files.length})`}>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {files.map((file) => (
              <div
                key={file.path}
                className="flex items-center justify-between p-2 hover:bg-gray-50 rounded"
              >
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono">
                    {file.status === 'added' && '➕'}
                    {file.status === 'modified' && '✏️'}
                    {file.status === 'deleted' && '🗑️'}
                    {file.status === 'renamed' && '📝'}
                  </span>
                  <span className="text-sm font-mono truncate">{file.path}</span>
                </div>
                <div className="flex gap-2 text-xs">
                  {file.additions > 0 && <span className="text-green-600">+{file.additions}</span>}
                  {file.deletions > 0 && <span className="text-red-600">-{file.deletions}</span>}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
};

export default DiffControls;
