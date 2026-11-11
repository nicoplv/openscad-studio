import { Vector3, type Camera } from 'three';
import { threeToOpenScadDelta } from '../../services/coordinateTransform';
import type { ViewerComment } from '../../types/aiChat';

export function threePointToCommentPosition(point: Vector3): ViewerComment['position'] {
  const converted = threeToOpenScadDelta(point);
  return { x: converted.x, y: converted.y, z: converted.z };
}

export function svgPointToCommentPosition(point: {
  x: number;
  y: number;
}): ViewerComment['position'] {
  return { x: point.x, y: -point.y, z: 0 };
}

export function projectCommentPosition(
  position: ViewerComment['position'],
  camera: Camera,
  surface: { width: number; height: number }
) {
  const point = new Vector3(position.x, position.z, -position.y).project(camera);
  return { x: ((point.x + 1) / 2) * surface.width, y: ((1 - point.y) / 2) * surface.height };
}

export function formatCommentPosition(comment: ViewerComment): string {
  const { x, y, z } = comment.position;
  const format = (value: number) => Number(value.toFixed(3)).toString();
  return `X ${format(x)} · Y ${format(y)}${comment.viewerKind === '3d' ? ` · Z ${format(z)}` : ''} ${comment.measurementUnit}`;
}
