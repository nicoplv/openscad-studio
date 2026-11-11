import type { ModelSelectionSurface } from '../analytics/runtime';
import type { MeasurementUnit } from '../stores/settingsStore';

export type VisionSupport = 'yes' | 'no' | 'unknown';
export type AssistantMessageState = 'complete' | 'cancelled' | 'error';
export type ToolCallState = 'pending' | 'completed' | 'error' | 'denied';

export interface AiContextUsage {
  inputTokens: number;
  contextLimit?: number;
}

export interface ToolCall {
  toolCallId: string;
  name: string;
  args?: Record<string, unknown>;
  state: ToolCallState;
  result?: unknown;
  errorText?: string;
}

export interface BaseMessage {
  id: string;
  timestamp: number;
}

export interface UserTextPart {
  type: 'text';
  text: string;
}

export interface UserImagePart {
  type: 'image';
  attachmentId: string;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
}

export interface ViewerComment {
  id: string;
  text: string;
  position: { x: number; y: number; z: number };
  viewerKind: '2d' | '3d';
  measurementUnit: MeasurementUnit;
  renderTargetPath: string;
  sourceHash?: string;
}

export type ViewerCommentContext = Pick<ViewerComment, 'renderTargetPath' | 'sourceHash'>;

export interface UserCommentPart {
  type: 'comment';
  comment: ViewerComment;
}

export type UserMessagePart = UserTextPart | UserImagePart | UserCommentPart;

export interface UserMessage extends BaseMessage {
  type: 'user';
  parts: UserMessagePart[];
  checkpointId?: string;
}

export interface AssistantMessage extends BaseMessage {
  type: 'assistant';
  turnId: string;
  content: string;
  state: AssistantMessageState;
}

export interface ToolCallMessage extends BaseMessage {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args?: Record<string, unknown>;
  state: ToolCallState;
  result?: unknown;
  errorText?: string;
}

export type Message = UserMessage | AssistantMessage | ToolCallMessage;

export interface Conversation {
  id: string;
  title: string;
  timestamp: number;
  messages: Message[];
}

export interface AiDraft {
  text: string;
  attachmentIds: string[];
  comments?: ViewerComment[];
}

export type AttachmentStatus = 'pending' | 'ready' | 'error';

export interface AttachmentRecord {
  id: string;
  filename: string;
  sourceSurface?: ModelSelectionSurface;
  sourceMimeType: string;
  normalizedMimeType?: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  previewUrl?: string;
  normalizedData?: string;
  status: AttachmentStatus;
  errorMessage?: string;
  dedupeKey: string;
}

export type AttachmentStore = Record<string, AttachmentRecord>;

export function getUserMessageText(message: UserMessage): string {
  return message.parts
    .filter((part): part is UserTextPart => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}
