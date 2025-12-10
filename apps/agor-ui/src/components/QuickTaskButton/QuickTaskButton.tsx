import { ThunderboltOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { useConnectionDisabled } from '../../contexts/ConnectionContext';

interface QuickTaskButtonProps {
  onClick?: () => void;
  hasRepos: boolean;
}

export const QuickTaskButton: React.FC<QuickTaskButtonProps> = ({ onClick, hasRepos }) => {
  const connectionDisabled = useConnectionDisabled();
  const disabled = connectionDisabled || !hasRepos;

  const tooltip = connectionDisabled
    ? 'Disconnected from daemon'
    : hasRepos
      ? 'Quick Task'
      : 'Create a repository first';

  return (
    <Tooltip title={tooltip} placement="left">
      <Button
        type="primary"
        shape="circle"
        size="large"
        icon={<ThunderboltOutlined style={{ fontSize: 20 }} />}
        onClick={onClick}
        disabled={disabled}
        style={{
          position: 'absolute',
          right: 90,
          top: 24,
          width: 56,
          height: 56,
          boxShadow: '0 4px 12px rgba(0, 0, 0, 0.15)',
          zIndex: 100,
        }}
      />
    </Tooltip>
  );
};
