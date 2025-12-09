/**
 * Diff Viewer Component
 *
 * Displays git diff in a side-by-side format with syntax highlighting.
 * Uses simple HTML/CSS to avoid heavy dependencies.
 */

import React from 'react';
import { Empty, Spin } from 'antd';
import type { GitDiffFile } from '@agor/core/types';

interface DiffViewerProps {
  diffOutput?: string;
  files?: GitDiffFile[];
  loading?: boolean;
  error?: string | null;
  onFileSelect?: (file: GitDiffFile) => void;
  selectedFile?: string;
}

interface DiffLine {
  type: 'context' | 'add' | 'del' | 'header';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

/**
 * Parse unified diff output into structured data
 */
function parseDiffOutput(diffOutput: string): {
  files: Array<{ name: string; lines: DiffLine[] }>;
  headers: Record<string, string>;
} {
  const lines = diffOutput.split('\n');
  const result: Array<{ name: string; lines: DiffLine[] }> = [];
  const headers: Record<string, string> = {};

  let currentFile = '';
  let currentLines: DiffLine[] = [];
  let oldLineNum = 0;
  let newLineNum = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Parse headers (e.g., diff --git a/file b/file)
    if (line.startsWith('diff --git')) {
      // Extract file name
      const match = line.match(/diff --git a\/(.+?) b\/(.+?)(?:\s|$)/);
      if (match) {
        // Save previous file if exists
        if (currentFile && currentLines.length > 0) {
          result.push({ name: currentFile, lines: currentLines });
        }

        // Start new file
        currentFile = match[2]; // Use new file name
        currentLines = [];
        oldLineNum = 0;
        newLineNum = 0;
      }
      continue;
    }

    // Parse index line (e.g., index abc123..def456 100644)
    if (line.startsWith('index ')) {
      continue;
    }

    // Parse file headers (e.g., --- a/file, +++ b/file)
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue;
    }

    // Parse hunk headers (e.g., @@ -1,3 +1,3 @@)
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (match) {
        oldLineNum = parseInt(match[1], 10);
        newLineNum = parseInt(match[3], 10);
      }
      currentLines.push({ type: 'header', content: line });
      continue;
    }

    // Parse diff content
    if (line.startsWith('+')) {
      // Added line
      currentLines.push({
        type: 'add',
        content: line.substring(1),
        newLineNumber: newLineNum++,
      });
    } else if (line.startsWith('-')) {
      // Deleted line
      currentLines.push({
        type: 'del',
        content: line.substring(1),
        oldLineNumber: oldLineNum++,
      });
    } else if (line.startsWith(' ')) {
      // Context line
      currentLines.push({
        type: 'context',
        content: line.substring(1),
        oldLineNumber: oldLineNum++,
        newLineNumber: newLineNum++,
      });
    } else if (line.startsWith('\\')) {
      // Special lines (e.g., No newline at end of file)
      currentLines.push({
        type: 'header',
        content: line,
      });
    }
  }

  // Add last file
  if (currentFile && currentLines.length > 0) {
    result.push({ name: currentFile, lines: currentLines });
  }

  return { files: result, headers };
}

/**
 * Render a single diff line
 */
function DiffLineView({ line, isLeft }: { line: DiffLine; isLeft: boolean }) {
  const getLineClass = () => {
    switch (line.type) {
      case 'add':
        return 'bg-green-50 border-l-2 border-green-500';
      case 'del':
        return 'bg-red-50 border-l-2 border-red-500';
      case 'header':
        return 'bg-gray-100 text-gray-600 text-xs';
      default:
        return 'bg-white';
    }
  };

  const getLineNumber = () => {
    if (line.type === 'add') {
      return isLeft ? '' : (line.newLineNumber || '').toString();
    } else if (line.type === 'del') {
      return isLeft ? (line.oldLineNumber || '').toString() : '';
    } else {
      return isLeft ? (line.oldLineNumber || '').toString() : (line.newLineNumber || '').toString();
    }
  };

  return (
    <div className={`flex text-sm font-mono ${getLineClass()}`}>
      <div className="w-12 text-right pr-2 text-gray-500 select-none">
        {getLineNumber()}
      </div>
      <div className="flex-1 px-2">
        <pre className="whitespace-pre-wrap break-words">{line.content || ' '}</pre>
      </div>
    </div>
  );
}

/**
 * Render a single file diff in side-by-side format
 */
function FileDiffView({ file }: { file: { name: string; lines: DiffLine[] } }) {
  return (
    <div className="border rounded-lg overflow-hidden mb-4">
      <div className="bg-gray-50 px-4 py-2 border-b font-semibold text-gray-700">
        {file.name}
      </div>

      <div className="grid grid-cols-2 divide-x">
        {/* Left side (original) */}
        <div className="bg-white">
          <div className="bg-gray-100 px-4 py-1 text-xs font-semibold text-gray-600 border-b">
            Original
          </div>
          <div>
            {file.lines.map((line, idx) => (
              <DiffLineView key={`left-${idx}`} line={line} isLeft={true} />
            ))}
          </div>
        </div>

        {/* Right side (modified) */}
        <div className="bg-white">
          <div className="bg-gray-100 px-4 py-1 text-xs font-semibold text-gray-600 border-b">
            Modified
          </div>
          <div>
            {file.lines.map((line, idx) => (
              <DiffLineView key={`right-${idx}`} line={line} isLeft={false} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Main DiffViewer component
 */
export const DiffViewer: React.FC<DiffViewerProps> = ({
  diffOutput,
  files,
  loading,
  error,
  onFileSelect,
  selectedFile,
}) => {
  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Spin size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span className="text-red-500">Failed to load diff: {error}</span>
          }
        />
      </div>
    );
  }

  if (!diffOutput || diffOutput.trim() === '') {
    return (
      <div className="p-4">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No differences found"
        />
      </div>
    );
  }

  // Parse diff output
  const parsed = parseDiffOutput(diffOutput);

  if (parsed.files.length === 0) {
    return (
      <div className="p-4">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No files changed"
        />
      </div>
    );
  }

  return (
    <div className="p-4">
      {parsed.files.map((file, idx) => (
        <FileDiffView key={idx} file={file} />
      ))}
    </div>
  );
};

export default DiffViewer;
