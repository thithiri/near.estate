import { createHmac, randomUUID } from "node:crypto";

const IMAGE_ENDPOINT = "https://api.openai.com/v1/images/generations";
const IMAGE_EDIT_ENDPOINT = "https://api.openai.com/v1/images/edits";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_PNG_BYTES = 16 * 1024 * 1024;

export type ImageProviderConfig = {
  apiKey: string;
  model: string;
  timeoutMs: number;
  safetySecret: string;
};

export type ImageGenerationResult = {
  png: Buffer;
  providerRequestId: string | null;
  clientRequestId: string;
  model: string;
};

export class ImageProviderError extends Error {
  constructor(
    message: string,
    readonly outcome: "rejected" | "uncertain",
    readonly providerRequestId: string | null = null,
    readonly clientRequestId: string | null = null,
  ) {
    super(message);
  }
}

function validateConfig(config: ImageProviderConfig): void {
  if (!config.apiKey.trim()) throw new Error("Image API key is required");
  if (!/^gpt-image-[a-z0-9.-]+-\d{4}-\d{2}-\d{2}$/.test(config.model))
    throw new Error("Image model must be an explicit dated snapshot");
  if (
    !Number.isSafeInteger(config.timeoutMs) ||
    config.timeoutMs < 10_000 ||
    config.timeoutMs > 300_000
  )
    throw new Error("Image request timeout must be 10–300 seconds");
  if (Buffer.byteLength(config.safetySecret, "utf8") < 32)
    throw new Error("Image safety identifier secret must be at least 32 bytes");
}

async function boundedResponse(response: Response): Promise<Buffer> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new ImageProviderError("Provider response is too large", "uncertain");
  }
  if (!response.body)
    throw new ImageProviderError(
      "Provider returned an empty response",
      "uncertain",
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new ImageProviderError(
          "Provider response is too large",
          "uncertain",
        );
      chunks.push(value);
    }
    complete = true;
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export class OpenAiImageProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(
    readonly config: ImageProviderConfig,
    fetchImpl: typeof fetch = fetch,
  ) {
    validateConfig(config);
    this.fetchImpl = fetchImpl;
  }

  async generate(
    prompt: string,
    accountId: string,
    clientRequestId: string = randomUUID(),
    referencePng: Buffer | null = null,
  ): Promise<ImageGenerationResult> {
    if (!prompt.trim() || prompt.length > 32_000)
      throw new ImageProviderError("Invalid image prompt", "rejected");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        clientRequestId,
      )
    )
      throw new ImageProviderError("Invalid client request ID", "rejected");
    if (
      referencePng &&
      (referencePng.length > MAX_PNG_BYTES ||
        !referencePng.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
    )
      throw new ImageProviderError("Invalid reference PNG", "rejected");
    const safetyIdentifier = createHmac("sha256", this.config.safetySecret)
      .update(accountId)
      .digest("hex");
    let response: Response;
    try {
      response = await this.fetchImpl(
        referencePng ? IMAGE_EDIT_ENDPOINT : IMAGE_ENDPOINT,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "X-Client-Request-Id": clientRequestId,
          },
          body: JSON.stringify({
            model: this.config.model,
            prompt,
            ...(referencePng
              ? {
                  images: [
                    {
                      image_url: `data:image/png;base64,${referencePng.toString("base64")}`,
                    },
                  ],
                }
              : {}),
            n: 1,
            size: "1024x1536",
            quality: "medium",
            background: "transparent",
            output_format: "png",
            safety_identifier: safetyIdentifier,
          }),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        },
      );
    } catch {
      throw new ImageProviderError(
        "Image request ended without a confirmed outcome",
        "uncertain",
        null,
        clientRequestId,
      );
    }
    const providerRequestId = response.headers.get("x-request-id");
    if (!response.ok) {
      // A server error or throttling may happen after work began. Preserve the
      // reservation until the operator can reconcile the provider request.
      const outcome =
        response.status >= 500 ||
        response.status === 429 ||
        response.status === 408
          ? "uncertain"
          : "rejected";
      throw new ImageProviderError(
        `Image provider returned HTTP ${response.status}`,
        outcome,
        providerRequestId,
        clientRequestId,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse((await boundedResponse(response)).toString("utf8"));
    } catch {
      throw new ImageProviderError(
        "Image provider returned an unreadable result",
        "uncertain",
        providerRequestId,
        clientRequestId,
      );
    }
    const encoded = (payload as { data?: { b64_json?: unknown }[] })?.data?.[0]
      ?.b64_json;
    if (
      typeof encoded !== "string" ||
      encoded.length > Math.ceil((MAX_PNG_BYTES * 4) / 3) + 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)
    )
      throw new ImageProviderError(
        "Image provider returned no valid PNG data",
        "uncertain",
        providerRequestId,
        clientRequestId,
      );
    const png = Buffer.from(encoded, "base64");
    if (
      png.length < PNG_SIGNATURE.length ||
      png.length > MAX_PNG_BYTES ||
      !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
    )
      throw new ImageProviderError(
        "Image provider returned invalid PNG bytes",
        "uncertain",
        providerRequestId,
        clientRequestId,
      );
    return {
      png,
      providerRequestId,
      clientRequestId,
      model: this.config.model,
    };
  }
}
