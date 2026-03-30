export interface UpdateModalData {
  version: string;
  notes: string;
  downloadUrl: string;
}

export interface AiProfile {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enableThinking: boolean;
}

export type EditableAiProfile = Omit<AiProfile, "id"> & { id?: string; isNew?: boolean };

export type AiProfileStatus = "loading" | "success" | "error" | "none";

export type AiProfileStatusMap = Record<string, AiProfileStatus>;
