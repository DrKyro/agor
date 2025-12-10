/**
 * Diff Viewer Component
 *
 * Displays git diff in a side-by-side format with syntax highlighting.
 * Uses simple HTML/CSS to avoid heavy dependencies.
 */

import type { GitDiffFile } from '@agor/core/types';
import { Empty, Spin, theme } from 'antd';
import React from 'react';

interface DiffViewerProps {
  diffOutput?: string;
  files?: GitDiffFile[];
  loading?: boolean;
  error?: string | null;
  onFileSelect?: (file: GitDiffFile) => void;
  selectedFile?: string;
  compact?: boolean; // when true, hide pure context + hunk headers
}

interface DiffLine {
  type: 'context' | 'add' | 'del' | 'header';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

type DiffRow =
  | {
      kind: 'header';
      text: string;
    }
  | {
      kind: 'pair';
      left?: { type: 'context' | 'del'; lineNumber?: number; content: string };
      right?: { type: 'context' | 'add'; lineNumber?: number; content: string };
    };

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
 * Convert linear diff lines to paired rows (GitHub-like)
 */
function pairLines(lines: DiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.type === 'header') {
      rows.push({ kind: 'header', text: line.content });
      continue;
    }
    if (line.type === 'context') {
      rows.push({
        kind: 'pair',
        left: { type: 'context', lineNumber: line.oldLineNumber, content: line.content },
        right: { type: 'context', lineNumber: line.newLineNumber, content: line.content },
      });
      continue;
    }
    if (line.type === 'del') {
      const next = lines[i + 1];
      if (next && next.type === 'add') {
        rows.push({
          kind: 'pair',
          left: { type: 'del', lineNumber: line.oldLineNumber, content: line.content },
          right: { type: 'add', lineNumber: next.newLineNumber, content: next.content },
        });
        i++; // skip the paired add
      } else {
        rows.push({
          kind: 'pair',
          left: { type: 'del', lineNumber: line.oldLineNumber, content: line.content },
        });
      }
      continue;
    }
    if (line.type === 'add') {
      rows.push({
        kind: 'pair',
        right: { type: 'add', lineNumber: line.newLineNumber, content: line.content },
      });
      continue;
    }
  }
  return rows;
}

/**
 * Render a single file diff in GitHub-like split view
 */
function FileDiffView({
  file,
  compact = false,
}: {
  file: { name: string; lines: DiffLine[] };
  compact?: boolean;
}) {
  const rows = React.useMemo(() => pairLines(file.lines), [file.lines]);
  const { token } = theme.useToken();

  const mono: React.CSSProperties = {
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: 12,
    lineHeight: 1.5,
  };
  const rowKey = (row: DiffRow, idx: number) => {
    if (row.kind === 'header') return `h-${idx}-${row.text}`;
    const l = row.left?.lineNumber ?? '';
    const r = row.right?.lineNumber ?? '';
    return `p-${idx}-${l}-${r}`;
  };

  const cellStyle = (type?: 'context' | 'add' | 'del'): React.CSSProperties => {
    if (type === 'add') {
      return {
        backgroundColor: token.colorSuccessBg,
        borderLeft: `3px solid ${token.colorSuccess}`,
      };
    }
    if (type === 'del') {
      return {
        backgroundColor: token.colorErrorBg,
        borderLeft: `3px solid ${token.colorError}`,
      };
    }
    return {
      backgroundColor: token.colorFillQuaternary,
    };
  };

  // Simple inline-change highlighter using common prefix/suffix
  function highlightInline(
    original?: { content: string; type: 'context' | 'del' } | undefined,
    modified?: { content: string; type: 'context' | 'add' } | undefined
  ): { left: React.ReactNode; right: React.ReactNode } {
    const leftText = original?.content ?? '';
    const rightText = modified?.content ?? '';

    // Only highlight when we have both sides and they differ
    if (!original || !modified || leftText === rightText) {
      return { left: leftText, right: rightText };
    }

    let i = 0;
    const minLen = Math.min(leftText.length, rightText.length);
    while (i < minLen && leftText[i] === rightText[i]) i++;

    let j = 0;
    const leftLen = leftText.length;
    const rightLen = rightText.length;
    while (j < minLen - i && leftText[leftLen - 1 - j] === rightText[rightLen - 1 - j]) j++;

    const leftMid = leftText.slice(i, leftLen - j);
    const rightMid = rightText.slice(i, rightLen - j);

    const left = (
      <span style={mono}>
        {leftText.slice(0, i)}
        <span
          style={{
            backgroundColor: token.colorErrorBg,
            color: token.colorErrorText,
          }}
        >
          {leftMid || ' '}
        </span>
        {leftText.slice(leftLen - j)}
      </span>
    );

    const right = (
      <span style={mono}>
        {rightText.slice(0, i)}
        <span
          style={{
            backgroundColor: token.colorSuccessBg,
            color: token.colorSuccessText,
          }}
        >
          {rightMid || ' '}
        </span>
        {rightText.slice(rightLen - j)}
      </span>
    );

    return { left, right };
  }

  return (
    <div
      style={{
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: 8,
        overflow: 'hidden',
        marginBottom: 16,
      }}
    >
      <div
        style={{
          padding: '8px 16px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          fontWeight: 600,
          background: token.colorFillSecondary,
        }}
      >
        {file.name}
      </div>
      <div style={{ overflow: 'auto' }}>
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontFamily: mono.fontFamily,
            fontSize: mono.fontSize,
          }}
        >
          <colgroup>
            <col style={{ width: '56px' }} />
            <col />
            <col style={{ width: '56px' }} />
            <col />
          </colgroup>
          <thead>
            <tr
              style={{
                background: token.colorFillTertiary,
                color: token.colorTextTertiary,
              }}
            >
              <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 400 }}>Old</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 400 }}>Original</th>
              <th style={{ textAlign: 'right', padding: '6px 8px', fontWeight: 400 }}>New</th>
              <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 400 }}>Modified</th>
            </tr>
          </thead>
          <tbody>
            {(compact
              ? rows.filter(
                  (row) =>
                    row.kind === 'pair' &&
                    (row.left?.type !== 'context' || row.right?.type !== 'context')
                )
              : rows
            ).map((row, idx) => {
              if (row.kind === 'header') {
                // Skip hunk header rows entirely in compact mode
                if (compact) return null;
                return (
                  <tr key={rowKey(row, idx)}>
                    <td
                      colSpan={4}
                      style={{
                        padding: '4px 12px',
                        fontSize: 12,
                        color: token.colorTextTertiary,
                        background: token.colorFillTertiary,
                      }}
                    >
                      {row.text}
                    </td>
                  </tr>
                );
              }
              const inline = highlightInline(row.left, row.right);
              return (
                <tr key={rowKey(row, idx)}>
                  <td
                    style={{
                      textAlign: 'right',
                      padding: '2px 6px',
                      color: token.colorTextTertiary,
                      userSelect: 'none',
                      verticalAlign: 'top',
                      ...cellStyle(row.left?.type),
                    }}
                  >
                    {row.left?.lineNumber ?? ''}
                  </td>
                  <td
                    style={{
                      padding: '2px 8px',
                      verticalAlign: 'top',
                      ...cellStyle(row.left?.type),
                    }}
                  >
                    <pre style={mono}>{inline.left}</pre>
                  </td>
                  <td
                    style={{
                      textAlign: 'right',
                      padding: '2px 6px',
                      color: token.colorTextTertiary,
                      userSelect: 'none',
                      verticalAlign: 'top',
                      ...cellStyle(row.right?.type),
                    }}
                  >
                    {row.right?.lineNumber ?? ''}
                  </td>
                  <td
                    style={{
                      padding: '2px 8px',
                      verticalAlign: 'top',
                      ...cellStyle(row.right?.type),
                    }}
                  >
                    <pre style={mono}>{inline.right}</pre>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
  compact = true,
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
          description={<span className="text-red-500">Failed to load diff: {error}</span>}
        />
      </div>
    );
  }

  if (!diffOutput || diffOutput.trim() === '') {
    return (
      <div className="p-4">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No differences found" />
      </div>
    );
  }

  // Parse diff output
  const parsed = parseDiffOutput(diffOutput);

  if (parsed.files.length === 0) {
    return (
      <div className="p-4">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No files changed" />
      </div>
    );
  }

  return (
    <div className="p-4">
      {parsed.files.map((file) => (
        <FileDiffView key={file.name} file={file} compact={compact} />
      ))}
    </div>
  );
};

export default DiffViewer;
