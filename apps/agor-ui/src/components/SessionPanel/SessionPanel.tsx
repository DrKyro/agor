import type { AgorClient } from '@agor/core/api';
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  Message,
  PermissionMode,
  Session,
  SpawnConfig,
  Worktree,
} from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import {
  BranchesOutlined,
  CloseOutlined,
  CodeOutlined,
  DeleteOutlined,
  ForkOutlined,
  GlobalOutlined,
  SendOutlined,
  SettingOutlined,
  StopOutlined,
} from '@ant-design/icons';
import { App, Badge, Button, Space, Spin, Tooltip, Typography, theme } from 'antd';
import React from 'react';
import { getDaemonUrl } from '../../config/daemon';
import { useAppActions } from '../../contexts/AppActionsContext';
import { useAppData } from '../../contexts/AppDataContext';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';
import { useTasks } from '../../hooks/useTasks';
import spawnSubsessionTemplate from '../../templates/spawn_subsession.hbs?raw';
import { getContextWindowGradient } from '../../utils/contextWindow';
import { getSessionDisplayTitle, getSessionTitleStyles } from '../../utils/sessionTitle';
import { compileTemplate } from '../../utils/templates';
import { ACCESS_TOKEN_KEY } from '../../utils/tokenRefresh';
import { AutocompleteTextarea } from '../AutocompleteTextarea';
import type { UploadedFile } from '../FileUpload';
import { FileUploadButton } from '../FileUpload';
import { CreatedByTag } from '../metadata';
import { PermissionModeSelector } from '../PermissionModeSelector';
import {
  ContextWindowPill,
  MessageCountPill,
  ModelPill,
  SessionIdPill,
  TimerPill,
  TokenCountPill,
} from '../Pill';
import { ThinkingModeSelector } from '../ThinkingModeSelector';
import { ToolIcon } from '../ToolIcon';
import { VSCodeIcon } from '../VSCodeIcon';
import { SessionPanelContent } from './SessionPanelContent';

// Re-export PermissionMode from SDK for convenience
export type { PermissionMode };

// Compile the spawn subsession template once at module level
const compiledSpawnSubsessionTemplate = compileTemplate<{ userPrompt: string }>(
  spawnSubsessionTemplate
);

const IMAGE_EXTENSION_REGEX = /\.(png|jpe?g|gif|bmp|webp|svg|heic|heif|tiff)$/i;

const isImageMimeType = (mimeType?: string | null): boolean => {
  return typeof mimeType === 'string' && mimeType.startsWith('image/');
};

const isImageFile = (file: File): boolean => {
  if (isImageMimeType(file.type)) return true;
  if (!file.name) return false;
  return IMAGE_EXTENSION_REGEX.test(file.name.toLowerCase());
};

const ensureImageFileHasName = (file: File, index: number): File => {
  if (file.name) return file;
  const type = file.type && isImageMimeType(file.type) ? file.type : 'image/png';
  const extension = type.split('/')[1] || 'png';
  const normalizedExt = extension === 'jpeg' ? 'jpg' : extension;
  const filename = `pasted-image-${Date.now()}-${index}.${normalizedExt}`;
  return new File([file], filename, { type });
};

type ImageAttachmentStatus = 'uploading' | 'uploaded' | 'error';

interface ImageAttachment {
  id: string;
  name: string;
  previewUrl: string;
  status: ImageAttachmentStatus;
  path?: string;
  error?: string;
}

export interface SessionPanelProps {
  client: AgorClient | null;
  session: Session | null;
  worktree?: Worktree | null;
  currentUserId?: string;
  sessionMcpServerIds?: string[];
  open: boolean;
  onClose: () => void;
}

const SessionPanel: React.FC<SessionPanelProps> = ({
  client,
  session,
  worktree = null,
  currentUserId,
  sessionMcpServerIds = [],
  open,
  onClose,
}) => {
  const { token } = theme.useToken();
  const { modal, message } = App.useApp();
  const connectionDisabled = useConnectionDisabled();

  // Get data from context
  const { userById } = useAppData();

  // Get actions from context
  const {
    onSendPrompt,
    onFork,
    onOpenSettings,
    onUpdateSession,
    onDeleteSession: onDelete,
    onOpenTerminal,
    onOpenVSCode,
    onOpenCodeServer,
  } = useAppActions();

  // Per-session draft storage
  const draftsRef = React.useRef<Map<string, string>>(new Map());
  const [inputValue, setInputValue] = React.useState(() => {
    return session ? draftsRef.current.get(session.session_id) || '' : '';
  });

  const prevSessionIdRef = React.useRef(session?.session_id);

  // Handle session switches
  React.useEffect(() => {
    if (!session) return;

    if (prevSessionIdRef.current !== session.session_id) {
      if (prevSessionIdRef.current && inputValue.trim()) {
        draftsRef.current.set(prevSessionIdRef.current, inputValue);
      } else if (prevSessionIdRef.current) {
        draftsRef.current.delete(prevSessionIdRef.current);
      }

      setInputValue(draftsRef.current.get(session.session_id) || '');
      prevSessionIdRef.current = session.session_id;
    }
  }, [session, inputValue]);

  const getDefaultPermissionMode = React.useCallback((agent?: string): PermissionMode => {
    return agent === 'codex' ? 'auto' : 'acceptEdits';
  }, []);

  const [permissionMode, setPermissionMode] = React.useState<PermissionMode>(
    session?.permission_config?.mode || getDefaultPermissionMode(session?.agentic_tool)
  );
  const [codexSandboxMode, setCodexSandboxMode] = React.useState<CodexSandboxMode>(
    session?.permission_config?.codex?.sandboxMode || 'workspace-write'
  );
  const [codexApprovalPolicy, setCodexApprovalPolicy] = React.useState<CodexApprovalPolicy>(
    session?.permission_config?.codex?.approvalPolicy || 'on-request'
  );
  const [thinkingMode, setThinkingMode] = React.useState<'auto' | 'manual' | 'off'>(
    session?.model_config?.thinkingMode || 'auto'
  );
  const [scrollToBottom, setScrollToBottom] = React.useState<(() => void) | null>(null);
  const [scrollToTop, setScrollToTop] = React.useState<(() => void) | null>(null);
  const [queuedMessages, setQueuedMessages] = React.useState<Message[]>([]);
  const [spawnModalOpen, setSpawnModalOpen] = React.useState(false);
  const [imageAttachments, setImageAttachments] = React.useState<ImageAttachment[]>([]);
  const previewUrlMapRef = React.useRef<Map<string, string>>(new Map());
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const daemonUrl = React.useMemo(() => getDaemonUrl(), []);

  const currentUser = currentUserId ? userById.get(currentUserId) || null : null;
  const { tasks } = useTasks(client, session?.session_id || null, currentUser, open);

  const registerPreviewUrl = React.useCallback((attachmentId: string, url: string) => {
    previewUrlMapRef.current.set(attachmentId, url);
  }, []);

  const revokePreviewUrl = React.useCallback((attachmentId: string) => {
    const existingUrl = previewUrlMapRef.current.get(attachmentId);
    if (existingUrl) {
      URL.revokeObjectURL(existingUrl);
      previewUrlMapRef.current.delete(attachmentId);
    }
  }, []);

  const clearImageAttachments = React.useCallback(() => {
    previewUrlMapRef.current.forEach((url) => {
      URL.revokeObjectURL(url);
    });
    previewUrlMapRef.current.clear();
    setImageAttachments([]);
  }, []);

  const insertFileMention = React.useCallback(
    (filepath: string) => {
      if (!filepath) return;
      const mentionPath = filepath.includes(' ') ? `"${filepath}"` : filepath;
      setInputValue((prev) => {
        const needsSpace = prev.length > 0 && !/\s$/.test(prev);
        const nextValue = `${prev}${needsSpace ? ' ' : ''}@${mentionPath}`;
        if (session) {
          draftsRef.current.set(session.session_id, nextValue);
        }
        return nextValue;
      });
    },
    [session]
  );

  const uploadImageAttachment = React.useCallback(
    async (attachmentId: string, file: File) => {
      if (!session) return;

      setImageAttachments((prev) =>
        prev.map((attachment) =>
          attachment.id === attachmentId
            ? { ...attachment, status: 'uploading', error: undefined }
            : attachment
        )
      );

      try {
        const formData = new FormData();
        formData.append('files', file);
        formData.append('notifyAgent', 'false');
        formData.append('message', 'Please review this file: {filepath}');

        const uploadUrl = `${daemonUrl}/sessions/${session.session_id}/upload?destination=worktree-temp`;
        const headers: HeadersInit = {};
        const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
        if (accessToken) {
          headers.Authorization = `Bearer ${accessToken}`;
        }

        const response = await fetch(uploadUrl, {
          method: 'POST',
          headers,
          body: formData,
          credentials: 'include',
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(errorText || 'Failed to upload image');
        }

        const result = await response.json();
        const uploadedFiles: UploadedFile[] | undefined = result?.files;
        const uploadedFile = Array.isArray(uploadedFiles) ? uploadedFiles[0] : undefined;
        if (!uploadedFile) {
          throw new Error('Upload response missing file metadata');
        }

        setImageAttachments((prev) =>
          prev.map((attachment) =>
            attachment.id === attachmentId
              ? { ...attachment, status: 'uploaded', path: uploadedFile.path }
              : attachment
          )
        );

        insertFileMention(uploadedFile.path);
        message.success(`图片已上传: ${uploadedFile.filename}`);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Failed to upload pasted image';
        setImageAttachments((prev) =>
          prev.map((attachment) =>
            attachment.id === attachmentId
              ? { ...attachment, status: 'error', error: errorMessage }
              : attachment
          )
        );
        message.error(errorMessage);
      }
    },
    [daemonUrl, insertFileMention, message, session]
  );

  const handleFilesForUpload = React.useCallback(
    (files: File[]) => {
      if (!session) {
        message.warning('请选择一个会话后再上传图片');
        return;
      }

      if (connectionDisabled) {
        message.warning('当前已离线，暂时无法上传图片');
        return;
      }

      const validFiles = files
        .filter((file) => isImageFile(file))
        .map((file, index) => ensureImageFileHasName(file, index));

      if (validFiles.length === 0) {
        message.warning('仅支持图片粘贴/拖拽上传');
        return;
      }

      validFiles.forEach((file) => {
        const attachmentId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const previewUrl = URL.createObjectURL(file);
        registerPreviewUrl(attachmentId, previewUrl);

        setImageAttachments((prev) => [
          ...prev,
          {
            id: attachmentId,
            name: file.name,
            previewUrl,
            status: 'uploading',
          },
        ]);

        uploadImageAttachment(attachmentId, file);
      });
    },
    [connectionDisabled, message, registerPreviewUrl, session, uploadImageAttachment]
  );

  const handleFileInputChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (!event.target.files) return;
      const selectedFiles = Array.from(event.target.files);
      handleFilesForUpload(selectedFiles);
      // Reset input so the same file can be selected again if needed
      event.target.value = '';
    },
    [handleFilesForUpload]
  );

  const removeAttachment = React.useCallback(
    (attachmentId: string) => {
      revokePreviewUrl(attachmentId);
      setImageAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
    },
    [revokePreviewUrl]
  );

  const hasPendingImageUploads = React.useMemo(() => {
    return imageAttachments.some((attachment) => attachment.status === 'uploading');
  }, [imageAttachments]);

  React.useEffect(() => {
    return () => {
      clearImageAttachments();
    };
  }, [clearImageAttachments]);

  React.useEffect(() => {
    clearImageAttachments();
  }, [clearImageAttachments]);

  // Fetch queued messages
  React.useEffect(() => {
    if (!client || !session) return;

    const fetchQueue = async () => {
      try {
        const response = await client
          .service(`/sessions/${session.session_id}/messages/queue`)
          .find();
        const data = (response as { data: Message[] }).data || [];
        setQueuedMessages(data);
      } catch (error) {
        console.error('[SessionPanel] Failed to fetch queue:', error);
      }
    };

    fetchQueue();

    // biome-ignore lint/suspicious/noExplicitAny: FeathersJS types
    const messagesService = client.service('messages') as any;

    const handleQueued = (msg: Message) => {
      if (msg.session_id === session.session_id) {
        setQueuedMessages((prev) =>
          [...prev, msg].sort((a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0))
        );
      }
    };

    const handleMessageRemoved = (msg: Message) => {
      if (msg.status === 'queued' && msg.session_id === session.session_id) {
        setQueuedMessages((prev) => prev.filter((m) => m.message_id !== msg.message_id));
      }
    };

    messagesService.on('queued', handleQueued);
    messagesService.on('removed', handleMessageRemoved);

    return () => {
      messagesService.off('queued', handleQueued);
      messagesService.off('removed', handleMessageRemoved);
    };
  }, [client, session]);

  // Token breakdown calculation
  const tokenBreakdown = React.useMemo(() => {
    if (!session?.agentic_tool) {
      return { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 };
    }

    return tasks.reduce(
      (acc, task) => {
        if (!task.normalized_sdk_response) return acc;

        const { tokenUsage, costUsd } = task.normalized_sdk_response;

        return {
          total: acc.total + tokenUsage.totalTokens,
          input: acc.input + tokenUsage.inputTokens,
          output: acc.output + tokenUsage.outputTokens,
          cacheRead: acc.cacheRead + (tokenUsage.cacheReadTokens || 0),
          cacheCreation: acc.cacheCreation + (tokenUsage.cacheCreationTokens || 0),
          cost: acc.cost + (costUsd || 0),
        };
      },
      { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 }
    );
  }, [tasks, session?.agentic_tool]);

  // Get latest context window
  const latestContextWindow = React.useMemo(() => {
    if (!session?.agentic_tool) return null;

    for (let i = tasks.length - 1; i >= 0; i--) {
      const task = tasks[i];
      if (task.computed_context_window !== undefined && task.normalized_sdk_response) {
        const { contextWindowLimit } = task.normalized_sdk_response;

        if (task.computed_context_window > 0) {
          return {
            used: task.computed_context_window,
            limit: contextWindowLimit || 0,
            taskMetadata: {
              model: task.model,
              duration_ms: task.duration_ms,
              agentic_tool: session.agentic_tool,
              raw_sdk_response: task.raw_sdk_response,
            },
          };
        }
      }
    }
    return null;
  }, [tasks, session?.agentic_tool]);

  const footerGradient = React.useMemo(() => {
    if (!latestContextWindow) return undefined;
    return getContextWindowGradient(latestContextWindow.used, latestContextWindow.limit);
  }, [latestContextWindow]);

  const footerTimerTask = React.useMemo(() => {
    if (tasks.length === 0) return null;

    for (let index = tasks.length - 1; index >= 0; index -= 1) {
      const candidate = tasks[index];
      if (
        candidate.status === TaskStatus.RUNNING ||
        candidate.status === TaskStatus.STOPPING ||
        candidate.status === TaskStatus.AWAITING_PERMISSION
      ) {
        return candidate;
      }
    }

    return tasks[tasks.length - 1];
  }, [tasks]);

  // Update permission mode when session changes
  React.useEffect(() => {
    if (session?.permission_config?.mode) {
      setPermissionMode(session.permission_config.mode);
    } else if (session?.agentic_tool) {
      setPermissionMode(getDefaultPermissionMode(session.agentic_tool));
    }

    if (session?.agentic_tool === 'codex' && session?.permission_config?.codex) {
      setCodexSandboxMode(session.permission_config.codex.sandboxMode);
      setCodexApprovalPolicy(session.permission_config.codex.approvalPolicy);
    }
  }, [
    session?.permission_config?.mode,
    session?.permission_config?.codex,
    session?.agentic_tool,
    getDefaultPermissionMode,
  ]);

  // Update thinking mode when session changes
  React.useEffect(() => {
    if (session?.model_config?.thinkingMode) {
      setThinkingMode(session.model_config.thinkingMode);
    }
  }, [session?.model_config?.thinkingMode]);

  // Scroll to bottom when panel opens or session changes
  React.useEffect(() => {
    if (open && scrollToBottom && session) {
      const timeoutId = setTimeout(() => {
        scrollToBottom();
      }, 300);
      return () => clearTimeout(timeoutId);
    }
  }, [open, scrollToBottom, session]);

  // Early return if no session
  if (!session) {
    return null;
  }

  const handleDelete = () => {
    modal.confirm({
      title: 'Delete Session',
      content: 'Are you sure you want to delete this session? This action cannot be undone.',
      okText: 'Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: () => {
        onDelete?.(session.session_id);
        onClose();
      },
    });
  };

  const isRunning =
    session.status === SessionStatus.RUNNING || session.status === SessionStatus.STOPPING;
  const isStopping = session.status === SessionStatus.STOPPING;

  const handleSendPrompt = async () => {
    if (!inputValue.trim()) return;
    if (hasPendingImageUploads) {
      message.warning('请等待图片上传完成');
      return;
    }

    const promptToSend = inputValue.trim();

    try {
      if (isRunning && client) {
        const response = (await client
          .service(`/sessions/${session.session_id}/messages/queue`)
          .create({
            prompt: promptToSend,
          })) as { success: boolean; message: Message; queue_position: number };

        if (response.message) {
          setQueuedMessages((prev) =>
            [...prev, response.message].sort(
              (a, b) => (a.queue_position ?? 0) - (b.queue_position ?? 0)
            )
          );
        }

        message.success(`Message queued at position ${response.message.queue_position}`);
        setInputValue('');
        draftsRef.current.delete(session.session_id);
        clearImageAttachments();
      } else {
        setInputValue('');
        draftsRef.current.delete(session.session_id);
        onSendPrompt?.(session.session_id, promptToSend, permissionMode);
        clearImageAttachments();
      }
    } catch (error) {
      message.error(
        `Failed to ${isRunning ? 'queue' : 'send'} message: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const handleStop = async () => {
    if (!session || !client || isStopping) return;

    try {
      await client.service(`sessions/${session.session_id}/stop`).create({});
    } catch (error) {
      console.error('❌ Failed to stop execution:', error);
    }
  };

  const handleFork = () => {
    if (!session) return;
    onFork?.(session.session_id, inputValue.trim());
    setInputValue('');
    draftsRef.current.delete(session.session_id);
  };

  const handleSubsession = () => {
    if (!inputValue.trim()) {
      setSpawnModalOpen(true);
      return;
    }

    const metaPrompt = compiledSpawnSubsessionTemplate({
      userPrompt: inputValue,
    });

    if (!session) return;
    onSendPrompt?.(session.session_id, metaPrompt, permissionMode);
    setInputValue('');
    draftsRef.current.delete(session.session_id);
  };

  const handleSpawnModalConfirm = async (config: string | Partial<SpawnConfig>) => {
    if (!session) return;

    if (typeof config === 'string') {
      const metaPrompt = compiledSpawnSubsessionTemplate({ userPrompt: config });
      await onSendPrompt?.(session.session_id, metaPrompt, permissionMode);
    } else {
      const hasConfig =
        config.agent !== undefined ||
        config.permissionMode !== undefined ||
        config.modelConfig !== undefined ||
        config.codexSandboxMode !== undefined ||
        config.codexApprovalPolicy !== undefined ||
        config.codexNetworkAccess !== undefined ||
        (config.mcpServerIds?.length ?? 0) > 0 ||
        config.enableCallback !== undefined ||
        config.includeLastMessage !== undefined ||
        config.includeOriginalPrompt !== undefined ||
        config.extraInstructions !== undefined;

      const Handlebars = await import('handlebars');
      Handlebars.registerHelper('isDefined', (value) => value !== undefined);

      const compiledTemplate = Handlebars.compile(spawnSubsessionTemplate);

      const metaPrompt = compiledTemplate({
        userPrompt: config.prompt || '',
        hasConfig,
        agenticTool: config.agent,
        permissionMode: config.permissionMode,
        modelConfig: config.modelConfig,
        codexSandboxMode: config.codexSandboxMode,
        codexApprovalPolicy: config.codexApprovalPolicy,
        codexNetworkAccess: config.codexNetworkAccess,
        mcpServerIds: config.mcpServerIds,
        hasCallbackConfig:
          config.enableCallback !== undefined ||
          config.includeLastMessage !== undefined ||
          config.includeOriginalPrompt !== undefined,
        callbackConfig: {
          enableCallback: config.enableCallback,
          includeLastMessage: config.includeLastMessage,
          includeOriginalPrompt: config.includeOriginalPrompt,
        },
        extraInstructions: config.extraInstructions,
      });

      await onSendPrompt?.(session.session_id, metaPrompt, permissionMode);
    }

    setSpawnModalOpen(false);
    setInputValue('');
  };

  const handlePermissionModeChange = (newMode: PermissionMode) => {
    setPermissionMode(newMode);

    if (session && onUpdateSession) {
      onUpdateSession(session.session_id, {
        permission_config: {
          ...session.permission_config,
          mode: newMode,
        },
      });
    }
  };

  const handleCodexPermissionChange = (
    sandbox: CodexSandboxMode,
    approval: CodexApprovalPolicy
  ) => {
    setCodexSandboxMode(sandbox);
    setCodexApprovalPolicy(approval);

    if (session && onUpdateSession) {
      onUpdateSession(session.session_id, {
        permission_config: {
          ...session.permission_config,
          codex: {
            ...session.permission_config?.codex,
            sandboxMode: sandbox,
            approvalPolicy: approval,
          },
        },
      });
    }
  };

  const handleThinkingModeChange = (newMode: 'auto' | 'manual' | 'off') => {
    setThinkingMode(newMode);

    if (session && onUpdateSession) {
      if (session.model_config) {
        onUpdateSession(session.session_id, {
          model_config: {
            ...session.model_config,
            thinkingMode: newMode,
          },
        });
      }
    }
  };

  const getStatusColor = () => {
    switch (session.status) {
      case 'running':
        return 'processing';
      case 'completed':
        return 'success';
      case 'failed':
        return 'error';
      default:
        return 'default';
    }
  };

  if (!open) return null;

  // Footer controls
  const footerControls = (
    <div
      style={{
        position: 'relative',
        flexShrink: 0,
        background: token.colorBgContainer,
        borderTop: `1px solid ${token.colorBorder}`,
        padding: `${token.sizeUnit * 2}px ${token.sizeUnit * 6}px ${token.sizeUnit * 3}px`,
        marginLeft: -token.sizeUnit * 6,
        marginRight: -token.sizeUnit * 6,
      }}
    >
      {footerGradient && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: footerGradient,
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />
      )}
      <Space
        direction="vertical"
        style={{ width: '100%', position: 'relative', zIndex: 1 }}
        size={8}
      >
        {imageAttachments.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: `${token.sizeUnit * 2}px`,
              padding: `${token.sizeUnit * 2}px`,
              border: `1px dashed ${token.colorBorder}`,
              borderRadius: token.borderRadius,
              background: token.colorBgContainerDisabled,
            }}
          >
            {imageAttachments.map((attachment) => (
              <div
                key={attachment.id}
                style={{
                  width: 148,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: token.sizeUnit,
                }}
              >
                <div
                  style={{
                    position: 'relative',
                    width: '100%',
                    paddingBottom: '62%',
                    background: token.colorFillAlter,
                    borderRadius: token.borderRadius,
                    overflow: 'hidden',
                  }}
                >
                  <img
                    src={attachment.previewUrl}
                    alt={attachment.name}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                    }}
                  />
                  <Button
                    type="text"
                    icon={<CloseOutlined />}
                    size="small"
                    style={{
                      position: 'absolute',
                      top: 4,
                      right: 4,
                      background: 'rgba(0,0,0,0.55)',
                      color: 'white',
                      borderRadius: '50%',
                      minWidth: 24,
                      width: 24,
                      height: 24,
                      padding: 0,
                    }}
                    onClick={() => removeAttachment(attachment.id)}
                  />
                  {attachment.status === 'uploading' && (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'rgba(0, 0, 0, 0.45)',
                      }}
                    >
                      <Spin size="small" />
                    </div>
                  )}
                  {attachment.status === 'error' && (
                    <div
                      style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'rgba(0, 0, 0, 0.65)',
                        padding: token.sizeUnit,
                        textAlign: 'center',
                      }}
                    >
                      <Typography.Text type="danger" style={{ color: 'white', fontSize: 12 }}>
                        {attachment.error || '上传失败'}
                      </Typography.Text>
                    </div>
                  )}
                </div>
                <Typography.Text ellipsis style={{ fontSize: token.fontSizeSM }}>
                  {attachment.name}
                </Typography.Text>
                {attachment.status === 'uploading' && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    正在上传...
                  </Typography.Text>
                )}
              </div>
            ))}
          </div>
        )}
        <AutocompleteTextarea
          value={inputValue}
          onChange={setInputValue}
          placeholder="Send a prompt, fork, or create a subsession... (type @ for autocomplete)"
          autoSize={{ minRows: 3, maxRows: 12 }}
          onKeyPress={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (inputValue.trim()) {
                handleSendPrompt();
              }
            }
          }}
          client={client}
          sessionId={session?.session_id || null}
          userById={userById}
          onFilesDrop={handleFilesForUpload}
        />
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: `${token.sizeUnit}px`,
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Space size={0} wrap>
            {footerTimerTask && (
              <TimerPill
                status={footerTimerTask.status}
                startedAt={
                  footerTimerTask.message_range?.start_timestamp || footerTimerTask.created_at
                }
                endedAt={
                  footerTimerTask.message_range?.end_timestamp || footerTimerTask.completed_at
                }
                durationMs={footerTimerTask.duration_ms}
                tooltip={
                  footerTimerTask.status === TaskStatus.RUNNING
                    ? 'Active task runtime'
                    : 'Last task duration'
                }
              />
            )}
            <SessionIdPill
              sessionId={session.session_id}
              sdkSessionId={session.sdk_session_id}
              agenticTool={session.agentic_tool}
              showCopy={true}
            />
            {session.model_config?.model && (
              <ModelPill
                model={
                  session.agentic_tool === 'opencode' &&
                  session.model_config.provider &&
                  session.model_config.model
                    ? `${session.model_config.provider}/${session.model_config.model}`
                    : session.model_config.model
                }
              />
            )}
            <MessageCountPill count={session.message_count} />
            {tokenBreakdown.total > 0 && (
              <TokenCountPill
                count={tokenBreakdown.total}
                estimatedCost={tokenBreakdown.cost}
                inputTokens={tokenBreakdown.input}
                outputTokens={tokenBreakdown.output}
                cacheReadTokens={tokenBreakdown.cacheRead}
                cacheCreationTokens={tokenBreakdown.cacheCreation}
              />
            )}
            {latestContextWindow && (
              <ContextWindowPill
                used={latestContextWindow.used}
                limit={latestContextWindow.limit}
                taskMetadata={latestContextWindow.taskMetadata}
              />
            )}
          </Space>
          <Space size={4} wrap style={{ marginLeft: 'auto' }}>
            {session.agentic_tool === 'claude-code' && (
              <ThinkingModeSelector
                value={thinkingMode}
                onChange={handleThinkingModeChange}
                size="small"
                compact
              />
            )}
            <PermissionModeSelector
              value={permissionMode}
              onChange={handlePermissionModeChange}
              agentic_tool={session.agentic_tool}
              codexSandboxMode={codexSandboxMode}
              codexApprovalPolicy={codexApprovalPolicy}
              onCodexChange={handleCodexPermissionChange}
              compact
              size="small"
            />
            {isRunning && <Spin size="small" />}
            <Space.Compact>
              <Tooltip
                title={
                  isStopping ? 'Stopping...' : isRunning ? 'Stop Execution' : 'No active execution'
                }
              >
                <Button
                  danger
                  icon={<StopOutlined />}
                  onClick={handleStop}
                  disabled={!isRunning || isStopping}
                  loading={isStopping}
                />
              </Tooltip>
              <Tooltip title="Advanced Spawn Options">
                <Button
                  icon={<SettingOutlined />}
                  onClick={() => setSpawnModalOpen(true)}
                  disabled={connectionDisabled || isRunning}
                />
              </Tooltip>
              <Tooltip title={isRunning ? 'Session is running...' : 'Fork Session'}>
                <Button
                  icon={<ForkOutlined />}
                  onClick={handleFork}
                  disabled={connectionDisabled || isRunning}
                />
              </Tooltip>
              <Tooltip title={isRunning ? 'Session is running...' : 'Spawn Subsession'}>
                <Button
                  icon={<BranchesOutlined />}
                  onClick={handleSubsession}
                  disabled={connectionDisabled || isRunning}
                />
              </Tooltip>
              <Tooltip title="添加图片">
                <span style={{ display: 'inline-flex' }}>
                  <FileUploadButton
                    onClick={() => fileInputRef.current?.click()}
                    disabled={connectionDisabled}
                  />
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    multiple
                    style={{ display: 'none' }}
                    onChange={handleFileInputChange}
                  />
                </span>
              </Tooltip>
              <Tooltip
                title={
                  hasPendingImageUploads
                    ? '图片上传中...'
                    : isRunning
                      ? 'Queue Message'
                      : 'Send Prompt'
                }
              >
                <Button
                  type="primary"
                  icon={<SendOutlined />}
                  onClick={handleSendPrompt}
                  disabled={connectionDisabled || !inputValue.trim() || hasPendingImageUploads}
                />
              </Tooltip>
            </Space.Compact>
          </Space>
        </div>
      </Space>
    </div>
  );

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: token.colorBgElevated,
        borderLeft: `1px solid ${token.colorBorder}`,
      }}
    >
      {/* Header */}
      <div
        style={{
          flexShrink: 0,
          padding: `${token.sizeUnit * 3}px ${token.sizeUnit * 6}px`,
          borderBottom: `1px solid ${token.colorBorder}`,
          background: token.colorBgContainer,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <Space size={12} align="start" style={{ flex: 1 }}>
            <ToolIcon tool={session.agentic_tool} size={40} />
            <div style={{ flex: 1 }}>
              <div style={{ marginBottom: 4 }}>
                <Typography.Text
                  strong
                  style={{
                    fontSize: 18,
                    ...getSessionTitleStyles(2),
                  }}
                >
                  {getSessionDisplayTitle(session, { includeAgentFallback: true })}
                </Typography.Text>
                <Badge
                  status={getStatusColor()}
                  text={session.status.toUpperCase()}
                  style={{ marginLeft: 12 }}
                />
              </div>
              {session.created_by && (
                <div>
                  <CreatedByTag
                    createdBy={session.created_by}
                    currentUserId={currentUserId}
                    userById={userById}
                    prefix="Created by"
                  />
                </div>
              )}
            </div>
          </Space>
          <Space size={4}>
            {onOpenTerminal && worktree && (
              <Tooltip title="Open terminal in worktree directory">
                <Button
                  type="text"
                  icon={<CodeOutlined />}
                  onClick={() => onOpenTerminal([`cd ${worktree.path}`], worktree.worktree_id)}
                />
              </Tooltip>
            )}
            {onOpenVSCode && worktree && (
              <Tooltip title="Open in VS Code">
                <Button
                  type="text"
                  icon={<VSCodeIcon offsetY={1} />}
                  onClick={() => onOpenVSCode(worktree.worktree_id)}
                />
              </Tooltip>
            )}
            {onOpenCodeServer && worktree && (
              <Tooltip title="在浏览器中打开 code-server">
                <Button
                  type="text"
                  icon={<GlobalOutlined />}
                  onClick={() => onOpenCodeServer(worktree.worktree_id)}
                />
              </Tooltip>
            )}
            {onOpenSettings && (
              <Tooltip title="Session Settings">
                <Button
                  type="text"
                  icon={<SettingOutlined />}
                  onClick={() => onOpenSettings(session.session_id)}
                />
              </Tooltip>
            )}
            {onDelete && (
              <Tooltip title="Delete Session">
                <Button type="text" danger icon={<DeleteOutlined />} onClick={handleDelete} />
              </Tooltip>
            )}
            <Tooltip title="Close Panel">
              <Button
                type="text"
                icon={<CloseOutlined />}
                onClick={onClose}
                style={{ marginLeft: token.sizeUnit }}
              />
            </Tooltip>
          </Space>
        </div>
      </div>

      {/* Body - Scrollable content */}
      <div
        style={{
          flex: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          padding: `${token.sizeUnit * 3}px ${token.sizeUnit * 6}px 0`,
        }}
      >
        <SessionPanelContent
          client={client}
          session={session}
          worktree={worktree}
          currentUserId={currentUserId}
          sessionMcpServerIds={sessionMcpServerIds}
          footerControls={footerControls}
          scrollToBottom={scrollToBottom}
          scrollToTop={scrollToTop}
          setScrollToBottom={setScrollToBottom}
          setScrollToTop={setScrollToTop}
          queuedMessages={queuedMessages}
          setQueuedMessages={setQueuedMessages}
          spawnModalOpen={spawnModalOpen}
          setSpawnModalOpen={setSpawnModalOpen}
          onSpawnModalConfirm={handleSpawnModalConfirm}
          inputValue={inputValue}
          isOpen={open}
        />
      </div>
    </div>
  );
};

export default SessionPanel;
