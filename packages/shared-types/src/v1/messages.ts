export interface HeliosRequest {
  concept: string;
  requestId: string;
}

export interface HeliosParams {
  color: string;
  contrast: string;
  tone: string;
  style: string;
  composition: string;
}

export interface HeliosResult {
  requestId: string;
  imageUrl: string;
  params: HeliosParams;
  modelVersion: string;
  cost: number;
}