/**
 * Git diff related types
 */

export type DiffStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface GitDiffFile {
  path: string;
  status: DiffStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
  oldPath?: string; // For renamed files
}

export interface GitDiffSummary {
  total: number;
  additions: number;
  deletions: number;
}

export interface GitDiffResult {
  files: GitDiffFile[];
  summary: GitDiffSummary;
}

export interface GitDiffOptions {
  from?: string; // Starting ref (commit, branch, or tag)
  to?: string; // Ending ref (commit, branch, or tag)
  file?: string; // Optional specific file to diff
  filter?: string; // File filter pattern
}

export interface GitRef {
  name: string;
  type: 'branch' | 'tag' | 'commit';
  current?: boolean;
}

export interface AvailableRefs {
  branches: string[];
  tags: string[];
  currentBranch?: string;
}

export interface DiffFilter {
  search?: string; // Search in file content
  filePattern?: string; // Filter by file pattern (e.g., "*.ts")
  status?: DiffStatus[]; // Filter by status
}
