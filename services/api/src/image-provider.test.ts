import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { ImageProviderError, OpenAiImageProvider } from "./image-provider.js";

const config = {
  apiKey: "test-api-key",
  model: "gpt-image-2.5-flare-2026-09-08",
  timeoutMs: 10_000,
  safetySecret: "test-secret-with-at-least-thirty-two-bytes",
};

test("image adapter sends pinned, transparent, single-image request", async () => {
  const png = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  const requests: { url: string; init: RequestInit }[] = [];
  const fakeFetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({ url: String(url), init: init! });
    return Response.json(
      { data: [{ b64_json: png.toString("base64") }] },
      { headers: { "x-request-id": "provider-123" } },
    );
  }) as typeof fetch;
  const provider = new OpenAiImageProvider(config, fakeFetch);
  const first = await provider.generate("A cafe facade", "one.testnet");
  const second = await provider.generate("A cafe facade", "one.testnet");
  const third = await provider.generate("A cafe facade", "two.testnet");
  assert.deepEqual(first.png, png);
  assert.equal(first.providerRequestId, "provider-123");
  assert.match(first.clientRequestId, /^[0-9a-f-]{36}$/);
  assert.equal(
    requests[0]!.url,
    "https://api.openai.com/v1/images/generations",
  );
  const firstRequest = requests[0]!.init;
  assert.equal(firstRequest.method, "POST");
  assert.equal(
    (firstRequest.headers as Record<string, string>).Authorization,
    "Bearer test-api-key",
  );
  assert.equal(
    (firstRequest.headers as Record<string, string>)["X-Client-Request-Id"],
    first.clientRequestId,
  );
  const body = JSON.parse(String(firstRequest.body));
  assert.deepEqual(
    {
      model: body.model,
      prompt: body.prompt,
      n: body.n,
      size: body.size,
      quality: body.quality,
      background: body.background,
      output_format: body.output_format,
    },
    {
      model: config.model,
      prompt: "A cafe facade",
      n: 1,
      size: "1024x1536",
      quality: "medium",
      background: "transparent",
      output_format: "png",
    },
  );
  assert.equal(body.safety_identifier.length, 64);
  assert.equal(
    body.safety_identifier,
    JSON.parse(String(requests[1]!.init.body)).safety_identifier,
  );
  assert.notEqual(
    body.safety_identifier,
    JSON.parse(String(requests[2]!.init.body)).safety_identifier,
  );
  assert.ok(!String(firstRequest.body).includes("one.testnet"));
  assert.notEqual(first.clientRequestId, second.clientRequestId);
  assert.notEqual(second.clientRequestId, third.clientRequestId);
  const persistedId = "c8b192aa-6a09-46cb-9dc1-d4af038e3eb0";
  assert.equal(
    (await provider.generate("A cafe facade", "one.testnet", persistedId))
      .clientRequestId,
    persistedId,
  );
});

test("image adapter distinguishes definite rejection from uncertain outcomes", async () => {
  const rejected = new OpenAiImageProvider(
    config,
    (async () => new Response("bad request", { status: 400 })) as typeof fetch,
  );
  await assert.rejects(rejected.generate("Facade", "one.testnet"), (error) => {
    assert.ok(error instanceof ImageProviderError);
    assert.equal(error.outcome, "rejected");
    assert.match(error.clientRequestId!, /^[0-9a-f-]{36}$/);
    return true;
  });
  const uncertain = new OpenAiImageProvider(config, (async () => {
    throw new Error("timeout");
  }) as typeof fetch);
  await assert.rejects(uncertain.generate("Facade", "one.testnet"), (error) => {
    assert.ok(error instanceof ImageProviderError);
    assert.equal(error.outcome, "uncertain");
    assert.match(error.clientRequestId!, /^[0-9a-f-]{36}$/);
    return true;
  });
  const invalid = new OpenAiImageProvider(config, (async () =>
    Response.json({ data: [{ b64_json: "aGVsbG8=" }] })) as typeof fetch);
  await assert.rejects(invalid.generate("Facade", "one.testnet"), (error) => {
    assert.ok(error instanceof ImageProviderError);
    assert.equal(error.outcome, "uncertain");
    return true;
  });
});

test("oversized provider response cancels its stream and remains uncertain", async () => {
  let cancelled = false;
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(24 * 1024 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const provider = new OpenAiImageProvider(
    config,
    (async () => new Response(oversized)) as typeof fetch,
  );
  await assert.rejects(provider.generate("Facade", "one.testnet"), (error) => {
    assert.ok(error instanceof ImageProviderError);
    assert.equal(error.outcome, "uncertain");
    return true;
  });
  assert.equal(cancelled, true);
});

test("image adapter sends approved art to the edit endpoint as an image reference", async () => {
  const reference = await sharp({
    create: {
      width: 560,
      height: 640,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  const requests: { url: string; init: RequestInit }[] = [];
  const provider = new OpenAiImageProvider(config, (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({ url: String(url), init: init! });
    return Response.json({
      data: [{ b64_json: reference.toString("base64") }],
    });
  }) as typeof fetch);
  await provider.generate(
    "Recolour this facade",
    "one.testnet",
    "c8b192aa-6a09-46cb-9dc1-d4af038e3eb0",
    reference,
  );
  assert.equal(requests[0]?.url, "https://api.openai.com/v1/images/edits");
  const body = JSON.parse(String(requests[0]?.init.body));
  assert.deepEqual(body.images, [
    { image_url: `data:image/png;base64,${reference.toString("base64")}` },
  ]);
  assert.equal(body.background, "transparent");
  assert.equal(body.output_format, "png");
  assert.equal(body.prompt, "Recolour this facade");
  await assert.rejects(
    provider.generate("Facade", "one.testnet", undefined, Buffer.from("bad")),
    (error) =>
      error instanceof ImageProviderError && error.outcome === "rejected",
  );
});

test("image adapter refuses floating models and unbounded timeouts", () => {
  assert.throws(
    () => new OpenAiImageProvider({ ...config, model: "gpt-image-2.5-flare" }),
  );
  assert.throws(() => new OpenAiImageProvider({ ...config, timeoutMs: 0 }));
  assert.throws(
    () => new OpenAiImageProvider({ ...config, safetySecret: "short" }),
  );
});
