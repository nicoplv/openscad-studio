import { useLayoutEffect, useRef, useState } from 'react';
import { TbMessageCircle } from 'react-icons/tb';
import { Button } from '../ui';
import { formatCommentPosition } from './commentGeometry';
import type { CommentPlacement } from './useViewerCommentSession';

export function CommentPopover({
  placement,
  surface,
  text,
  error,
  canAttach,
  isAttaching,
  onTextChange,
  onAttach,
  onCancel,
}: {
  placement: CommentPlacement;
  surface: { width: number; height: number };
  text: string;
  error: string | null;
  canAttach: boolean;
  isAttaching: boolean;
  onTextChange: (text: string) => void;
  onAttach: () => void;
  onCancel: () => void;
}) {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const width = Math.min(288, Math.max(0, surface.width - 16));
  const { x, y } = placement.anchor;
  const left = Math.max(8, Math.min(x + 16, surface.width - width - 8));
  const top = Math.max(8, Math.min(y + 16, surface.height - panelHeight - 8));
  const submitDisabled = !text.trim() || !canAttach || isAttaching;

  useLayoutEffect(() => {
    fieldRef.current?.focus();
  }, [placement.comment.id]);

  useLayoutEffect(() => {
    if (!panelRef.current) return;
    const update = () => setPanelHeight(panelRef.current?.getBoundingClientRect().height ?? 0);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className="absolute inset-0 z-30"
      data-testid="viewer-comment-overlay"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        } else if (
          event.key === 'Enter' &&
          (event.ctrlKey || event.metaKey) &&
          !event.nativeEvent.isComposing
        ) {
          event.preventDefault();
          if (!submitDisabled) onAttach();
        }
      }}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <div
        className="absolute flex h-6 w-6 items-center justify-center rounded-full border"
        style={{
          left: x,
          top: y,
          transform: 'translate(-50%, -50%)',
          backgroundColor: 'var(--accent-primary)',
          color: 'var(--text-inverse)',
          borderColor: 'var(--bg-primary)',
        }}
        aria-hidden="true"
        data-testid="viewer-comment-pin"
      >
        <TbMessageCircle size={15} />
      </div>
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Add model comment"
        className="absolute overflow-y-auto rounded-lg border p-3 ph-no-capture"
        style={{
          left,
          top,
          width,
          maxHeight: Math.max(0, surface.height - 16),
          backgroundColor: 'var(--bg-elevated)',
          borderColor: 'var(--border-primary)',
          color: 'var(--text-primary)',
        }}
      >
        <label htmlFor={`comment-${placement.comment.id}`} className="block text-xs font-medium">
          Comment
        </label>
        <div className="mt-1 text-[11px] break-words" style={{ color: 'var(--text-secondary)' }}>
          {formatCommentPosition(placement.comment)}
        </div>
        <textarea
          ref={fieldRef}
          id={`comment-${placement.comment.id}`}
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder="What should change here?"
          rows={3}
          disabled={isAttaching}
          className="mt-2 w-full resize-y rounded border p-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
          style={{
            backgroundColor: 'var(--bg-primary)',
            borderColor: 'var(--border-primary)',
            color: 'var(--text-primary)',
          }}
        />
        {error ? (
          <div role="alert" className="mt-1 text-xs" style={{ color: 'var(--color-error)' }}>
            {error}
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <Button size="sm" onClick={onCancel} disabled={isAttaching}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={onAttach} disabled={submitDisabled}>
            {isAttaching ? 'Attaching...' : 'Attach to AI'}
          </Button>
        </div>
      </div>
    </div>
  );
}
