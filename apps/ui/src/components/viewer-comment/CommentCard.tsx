import { TbMessageCircle, TbX } from 'react-icons/tb';
import type { ViewerComment } from '../../types/aiChat';
import { IconButton } from '../ui';
import { formatCommentPosition } from './commentGeometry';

export function CommentCard({
  comment,
  onRemove,
}: {
  comment: ViewerComment;
  onRemove?: () => void;
}) {
  return (
    <div
      className="min-w-0 rounded-md border p-2 ph-no-capture"
      style={{
        backgroundColor: 'var(--bg-secondary)',
        borderColor: 'var(--border-secondary)',
        color: 'var(--text-primary)',
      }}
      data-testid="ai-comment-card"
    >
      <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
        <TbMessageCircle size={14} className="shrink-0" />
        <span className="flex-1">{comment.viewerKind.toUpperCase()} comment</span>
        {onRemove ? (
          <IconButton size="sm" title="Remove comment" onClick={onRemove}>
            <TbX size={14} />
          </IconButton>
        ) : null}
      </div>
      <div className="mt-1 whitespace-pre-wrap break-words text-sm">{comment.text}</div>
      <div className="mt-1 break-words text-[11px]" style={{ color: 'var(--text-secondary)' }}>
        {formatCommentPosition(comment)}
      </div>
      <div className="mt-0.5 break-all text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
        {comment.renderTargetPath}
      </div>
    </div>
  );
}
