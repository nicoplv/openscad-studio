import { useCallback, useEffect, useRef, useState } from 'react';
import type { ViewerComment, ViewerCommentContext } from '../../types/aiChat';
import { createRandomId } from '../../utils/randomId';
import { toast } from 'sonner';

export type ViewerCommentAttachResult =
  | { status: 'attached' }
  | { status: 'missing-api-key' }
  | { status: 'busy' }
  | { status: 'failed'; errors: string[] };

export interface CommentPlacement {
  comment: ViewerComment;
  anchor: { x: number; y: number };
  previewKey: string;
}

export function useViewerCommentSession({
  active,
  previewKey,
  context,
  viewerKind,
  measurementUnit,
  onAttach,
  onNotice,
}: {
  active: boolean;
  previewKey: string;
  context?: ViewerCommentContext;
  viewerKind: ViewerComment['viewerKind'];
  measurementUnit: ViewerComment['measurementUnit'];
  onAttach?: (comment: ViewerComment) => Promise<ViewerCommentAttachResult>;
  onNotice: (message: string) => void;
}) {
  const [placement, setPlacement] = useState<CommentPlacement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isAttaching, setIsAttaching] = useState(false);
  const attachingRef = useRef(false);
  const placementRef = useRef(placement);
  placementRef.current = placement;

  useEffect(
    () => () => {
      if (placementRef.current) {
        toast.info('Preview closed or changed. Place your comment again.', {
          id: 'viewer-comment-reset',
        });
      }
    },
    []
  );

  const cancel = useCallback(() => {
    setPlacement(null);
    setError(null);
  }, []);

  useEffect(() => {
    if (placement && (!active || placement.previewKey !== previewKey)) {
      cancel();
      if (placement.previewKey !== previewKey) {
        onNotice('Preview changed. Place your comment again.');
      }
    }
  }, [active, cancel, onNotice, placement, previewKey]);

  const place = (position: ViewerComment['position'], anchor: CommentPlacement['anchor']) => {
    if (!active || placement || !context) return;
    setError(null);
    setPlacement({
      comment: {
        ...context,
        id: createRandomId(),
        text: '',
        position,
        viewerKind,
        measurementUnit,
      },
      anchor,
      previewKey,
    });
  };

  const setText = (text: string) => {
    setPlacement(
      (current) =>
        current && {
          ...current,
          comment: { ...current.comment, text },
        }
    );
    setError(null);
  };

  const updateAnchor = useCallback((anchor: CommentPlacement['anchor']) => {
    setPlacement((current) => {
      if (!current || Math.hypot(current.anchor.x - anchor.x, current.anchor.y - anchor.y) < 0.5)
        return current;
      return { ...current, anchor };
    });
  }, []);

  const attach = async () => {
    if (!placement?.comment.text.trim() || !onAttach || attachingRef.current) return;
    attachingRef.current = true;
    setIsAttaching(true);
    setError(null);
    try {
      const result = await onAttach({
        ...placement.comment,
        text: placement.comment.text.trim(),
      });
      if (result.status === 'attached') {
        setPlacement((current) => (current?.comment.id === placement.comment.id ? null : current));
        onNotice('Comment attached to AI');
      } else {
        setError(
          result.status === 'missing-api-key'
            ? 'Configure an AI provider in Settings, then attach your comment.'
            : result.status === 'busy'
              ? 'Wait for the current AI request or attachment processing to finish.'
              : (result.errors[0] ?? 'Failed to attach the comment.')
        );
      }
    } catch {
      setError('Failed to attach the comment. Try again.');
    } finally {
      attachingRef.current = false;
      setIsAttaching(false);
    }
  };

  return { placement, error, isAttaching, place, setText, updateAnchor, cancel, attach };
}
