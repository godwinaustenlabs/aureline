export { bytesToBase64, toDataUrl } from "./base64";

export { buildAiRunOptions, DEFAULT_IMAGE_CACHE_TTL } from "./aiGateway";
export type { GatewayConfig, AiRunOptions } from "./aiGateway";

export { getTextualModelOutput } from "./getTextualModelOutput";
export type {
  GetTextualModelOutputOptions,
  AiRunner,
  TextualModelOutput,
} from "./getTextualModelOutput";
export { getImageModelOutput } from "./getImageModelOutput";
export type {
  ImageAiRunner,
  ImageModelOutput,
  GetImageModelOutputOptions,
} from "./getImageModelOutput";

export {
  getImageToImageOutput,
  MAX_INPUT_IMAGE_DIMENSION,
  MAX_INPUT_IMAGES,
} from "./getImageToImageOutput";
export type {
  InputImage,
  ImageToImageOutput,
  GetImageToImageOutputOptions,
} from "./getImageToImageOutput";

export { readJpegDimensions } from "./imageDimensions";

export { runToolLoop, SEARCH_TOOL } from "./runToolLoop";
export type {
  RunToolLoopConfig,
  RunToolLoopOptions,
  ToolLoopResult,
  ToolLoopEnv,
  SearchRunner,
  RetrievedChunk,
} from "./runToolLoop";
