/** @jest-environment jsdom */

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { jest } from '@jest/globals';
import * as THREE from 'three';
import { CommentPopover } from '../viewer-comment/CommentPopover';
import { CommentCard } from '../viewer-comment/CommentCard';
import {
  useViewerCommentSession,
  type ViewerCommentAttachResult,
} from '../viewer-comment/useViewerCommentSession';
import {
  threePointToCommentPosition,
  svgPointToCommentPosition,
  projectCommentPosition,
} from '../viewer-comment/commentGeometry';
import { clientToSvgPoint } from '../svg-viewer/viewportMath';
import { raycastLoadedModel } from '../three-viewer/selectionController';
import type { ViewerComment } from '../../types/aiChat';
import { TooltipProvider } from '../ui/Tooltip';
import { AiComposer } from '../AiComposer';

const comment: ViewerComment = {
  id: 'comment-1',
  text: 'Make the hole bigger',
  position: { x: 12.3456789, y: -20, z: 5 },
  viewerKind: '3d',
  measurementUnit: 'mm',
  renderTargetPath: 'parts/main.scad',
  sourceHash: 'original-render',
};

describe('viewer comments', () => {
  afterEach(() => jest.restoreAllMocks());
  beforeEach(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  it('converts a translated model surface hit back to unrounded OpenSCAD coordinates and rejects misses', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshBasicMaterial());
    mesh.position.set(12.3456789, 20, 30);
    const root = new THREE.Group();
    root.rotation.x = -Math.PI / 2;
    root.add(mesh);
    root.updateMatrixWorld(true);
    const center = new THREE.Vector3(12.3456789, 20, 30).applyMatrix4(root.matrixWorld);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.copy(center).add(new THREE.Vector3(0, 10, 0));
    camera.up.set(0, 0, -1);
    camera.lookAt(center);
    camera.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(root);
    const model = {
      root,
      meshes: [mesh],
      bounds,
      center,
      size: bounds.getSize(new THREE.Vector3()),
      diagonal: 4,
      version: '1',
    };
    const args = { camera, model, rect: { left: 0, top: 0, width: 400, height: 400 } };
    const hit = raycastLoadedModel({ ...args, clientX: 200, clientY: 200 });
    expect(hit).not.toBeNull();
    const point = threePointToCommentPosition(hit!.point);
    expect(point.x).toBeCloseTo(12.3456789, 7);
    expect(point.y).toBeCloseTo(20, 7);
    expect(point.z).toBeCloseTo(31, 7);
    const anchor = projectCommentPosition(point, camera, { width: 600, height: 400 });
    expect(anchor.x).toBeCloseTo(300, 7);
    expect(anchor.y).toBeCloseTo(200, 7);
    expect(raycastLoadedModel({ ...args, clientX: 0, clientY: 0 })).toBeNull();
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  });

  it('undoes viewport pan and zoom without subtracting the SVG document origin', () => {
    const point = clientToSvgPoint(
      175,
      160,
      { left: 15, top: 10 },
      { scale: 2, translateX: 210, translateY: 110 }
    );
    expect(svgPointToCommentPosition(point)).toEqual({ x: -25, y: -20, z: 0 });
  });

  it('captures render identity at placement and removes the pin only after attachment succeeds', async () => {
    const onAttach = jest
      .fn<(value: ViewerComment) => Promise<ViewerCommentAttachResult>>()
      .mockResolvedValue({ status: 'busy' });
    const onNotice = jest.fn();
    const { result, rerender } = renderHook(
      ({ path }) =>
        useViewerCommentSession({
          active: true,
          previewKey: 'render-1',
          context: { renderTargetPath: path, sourceHash: 'hash-1' },
          viewerKind: '3d',
          measurementUnit: 'mm',
          onAttach,
          onNotice,
        }),
      { initialProps: { path: 'main.scad' } }
    );
    act(() => result.current.place(comment.position, { x: 40, y: 50 }));
    act(() => result.current.setText('  Make the hole bigger  '));
    rerender({ path: 'other-editor-tab.scad' });
    await act(async () => result.current.attach());
    expect(result.current.placement?.comment.text).toBe('  Make the hole bigger  ');
    expect(result.current.error).toContain('Wait');
    onAttach.mockResolvedValue({ status: 'attached' });
    await act(async () => result.current.attach());
    expect(onAttach).toHaveBeenLastCalledWith(
      expect.objectContaining({
        renderTargetPath: 'main.scad',
        sourceHash: 'hash-1',
        text: 'Make the hole bigger',
        position: comment.position,
      })
    );
    expect(result.current.placement).toBeNull();
    expect(onNotice).toHaveBeenCalledWith('Comment attached to AI');
  });

  it.each([
    { status: 'missing-api-key' } as ViewerCommentAttachResult,
    { status: 'failed', errors: ['Could not attach'] } as ViewerCommentAttachResult,
  ])('preserves the input when attachment returns $status', async (failure) => {
    const { result } = renderHook(() =>
      useViewerCommentSession({
        active: true,
        previewKey: 'one',
        context: { renderTargetPath: 'main.scad' },
        viewerKind: '2d',
        measurementUnit: 'mm',
        onAttach: async () => failure,
        onNotice: () => {},
      })
    );
    act(() => result.current.place(comment.position, { x: 40, y: 50 }));
    act(() => result.current.setText('Keep this instruction'));
    await act(async () => result.current.attach());
    expect(result.current.placement?.comment.text).toBe('Keep this instruction');
    expect(result.current.error).toBeTruthy();
  });

  it('cancels a temporary placement when the preview changes or Comment mode ends', () => {
    const onNotice = jest.fn();
    const { result, rerender } = renderHook(
      ({ active, previewKey }) =>
        useViewerCommentSession({
          active,
          previewKey,
          context: { renderTargetPath: 'main.scad' },
          viewerKind: '2d',
          measurementUnit: 'mm',
          onNotice,
        }),
      { initialProps: { active: true, previewKey: 'one' } }
    );
    act(() => result.current.place(comment.position, { x: 40, y: 50 }));
    rerender({ active: true, previewKey: 'two' });
    expect(result.current.placement).toBeNull();
    expect(onNotice).toHaveBeenCalledWith('Preview changed. Place your comment again.');
    act(() => result.current.place(comment.position, { x: 40, y: 50 }));
    rerender({ active: false, previewKey: 'two' });
    expect(result.current.placement).toBeNull();
  });

  it('focuses the form, isolates typing from viewer shortcuts, and supports attach/cancel keys', () => {
    const onAttach = jest.fn();
    const onCancel = jest.fn();
    const onViewerKey = jest.fn();
    const onViewerPointer = jest.fn();
    const props = {
      placement: { comment, anchor: { x: 380, y: 290 }, previewKey: 'one' },
      surface: { width: 400, height: 300 },
      text: '   ',
      error: null,
      canAttach: true,
      isAttaching: false,
      onTextChange: jest.fn(),
      onAttach,
      onCancel,
    };
    const { rerender } = render(
      <div onKeyDown={onViewerKey} onPointerDown={onViewerPointer}>
        <CommentPopover {...props} />
      </div>
    );
    const field = screen.getByRole('textbox');
    expect(document.activeElement).toBe(field);
    expect(
      (screen.getByRole('button', { name: 'Attach to AI' }) as HTMLButtonElement).disabled
    ).toBe(true);
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    expect(onAttach).not.toHaveBeenCalled();
    rerender(
      <div onKeyDown={onViewerKey} onPointerDown={onViewerPointer}>
        <CommentPopover {...props} text={comment.text} />
      </div>
    );
    fireEvent.pointerDown(field);
    for (const key of ['a', 'm', 'Backspace', 'Enter']) fireEvent.keyDown(field, { key });
    expect(onViewerKey).not.toHaveBeenCalled();
    expect(onViewerPointer).not.toHaveBeenCalled();
    expect(onAttach).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });
    expect(onAttach).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    const panel = screen.getByRole('dialog');
    expect(Number.parseFloat(panel.style.left)).toBeLessThanOrEqual(104);
    expect(Number.parseFloat(panel.style.width)).toBe(288);
  });

  it('renders comment text safely and exposes removal without changing its coordinates', () => {
    const onRemove = jest.fn();
    render(
      <TooltipProvider>
        <CommentCard comment={{ ...comment, text: '<script>test</script>' }} onRemove={onRemove} />
      </TooltipProvider>
    );
    expect(screen.getByText('<script>test</script>')).toBeTruthy();
    expect(screen.getByText('3D comment')).toBeTruthy();
    expect(screen.getByText(/X 12.346/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove comment' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(comment.position.x).toBe(12.3456789);
  });

  it('constrains the form to a narrow preview after measuring its height', () => {
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 184,
      bottom: 220,
      width: 184,
      height: 220,
      toJSON: () => ({}),
    });
    render(
      <CommentPopover
        placement={{ comment, anchor: { x: 195, y: 235 }, previewKey: 'one' }}
        surface={{ width: 200, height: 240 }}
        text={comment.text}
        error={null}
        canAttach={true}
        isAttaching={false}
        onTextChange={() => {}}
        onAttach={() => {}}
        onCancel={() => {}}
      />
    );
    const panel = screen.getByRole('dialog');
    expect(panel.style.left).toBe('8px');
    expect(panel.style.top).toBe('12px');
    expect(panel.style.width).toBe('184px');
    expect(panel.style.maxHeight).toBe('224px');
  });

  it('shows removable comment cards in the composer and sends comment-only drafts', () => {
    const onRemoveComment = jest.fn();
    const onSubmit = jest.fn();
    render(
      <TooltipProvider>
        <AiComposer
          draft={{ text: '', attachmentIds: [], comments: [comment] }}
          attachments={{}}
          isProcessingAttachments={false}
          canSubmit={true}
          placeholder="Describe changes"
          onTextChange={() => {}}
          onFilesSelected={() => {}}
          onRemoveAttachment={() => {}}
          onRemoveComment={onRemoveComment}
          onSubmit={onSubmit}
        />
      </TooltipProvider>
    );
    expect(screen.getByText(comment.text)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove comment' }));
    expect(onRemoveComment).toHaveBeenCalledWith(comment.id);
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
