export interface Voice {
  id: string;
  name: string;
}

export interface TTSRequest {
  text: string;
  voice?: string;
}

export interface TTSResponse {
  audio_url: string;
}