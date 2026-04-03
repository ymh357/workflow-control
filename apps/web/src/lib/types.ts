export interface DisplayMessage {
  id: string;
  type: string;
  timestamp: string;
  content: string;
  detail?: Record<string, unknown>;
  stage?: string;
}
