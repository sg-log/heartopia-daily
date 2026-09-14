import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { interpretWeatherEvidence, WeatherAiError } from "./weather-ai-interpret.mjs";

const image = await readFile(new URL("../assets/weather-templates/sun-day.png", import.meta.url));
const hash = createHash("sha256").update(image).digest("hex");
const capture = {
  status: "captured",
  evidence: { mimeType: "image/png", byteSize: image.length, sha256: hash }
};
const interpretation = {
  ready: true,
  observedDate: "2026-09-11",
  startSlot: "06",
  slots: [
    { slot: "slot0", visible: true, weather: ["晴"], confidence: "high", description: "06 sun" },
    { slot: "slot1", visible: true, weather: ["雨"], confidence: "high", description: "12 rain" },
    { slot: "slot2", visible: true, weather: ["月"], confidence: "high", description: "18 moon" },
    { slot: "slot3", visible: true, weather: ["月"], confidence: "high", description: "00 moon" },
    { slot: "slot4", visible: true, weather: ["晴"], confidence: "high", description: "06 sun" }
  ],
  confidence: "high",
  summary: "All required hourly fields are visible.",
  unresolved: []
};

function responseFor(value = interpretation) {
  return {
    ok: true,
    async json() {
      return {
        id: "resp_synthetic",
        status: "completed",
        model: "synthetic-model",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value) }] }]
      };
    }
  };
}

test("sends only the verified evidence image and returns structured hourly facts", async () => {
  let request;
  const result = await interpretWeatherEvidence({
    capture,
    evidenceBytes: image,
    apiKey: "synthetic-key",
    model: "synthetic-model",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.openai.com/v1/responses");
      assert.equal(options.headers.Authorization, "Bearer synthetic-key");
      request = JSON.parse(options.body);
      return responseFor();
    }
  });
  assert.equal(result.inputSha256, hash);
  assert.deepEqual(result.interpretation.slots[1].weather, ["雨"]);
  assert.equal(request.store, false);
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.strict, true);
  const imageInput = request.input[0].content.find((item) => item.type === "input_image");
  assert.ok(imageInput.image_url.startsWith("data:image/png;base64,"));
  assert.doesNotMatch(JSON.stringify(request), /sourceUrl|postContent|weeklyForecast/);
});

test("fails before the API when evidence bytes do not match capture metadata", async () => {
  let called = false;
  await assert.rejects(
    interpretWeatherEvidence({
      capture,
      evidenceBytes: Buffer.concat([image, Buffer.from([0])]),
      apiKey: "synthetic-key",
      fetchImpl: async () => { called = true; return responseFor(); }
    }),
    (error) => error instanceof WeatherAiError && error.code === "evidenceSizeMismatch"
  );
  assert.equal(called, false);
});

test("rejects reordered slots and unknown weather even when the model says ready", async () => {
  const reordered = structuredClone(interpretation);
  [reordered.slots[0], reordered.slots[1]] = [reordered.slots[1], reordered.slots[0]];
  await assert.rejects(
    interpretWeatherEvidence({ capture, evidenceBytes: image, apiKey: "synthetic-key", fetchImpl: async () => responseFor(reordered) }),
    (error) => error instanceof WeatherAiError && error.code === "invalidInterpretation"
  );
  const unknown = structuredClone(interpretation);
  unknown.slots[0].weather = ["曇"];
  await assert.rejects(
    interpretWeatherEvidence({ capture, evidenceBytes: image, apiKey: "synthetic-key", fetchImpl: async () => responseFor(unknown) }),
    (error) => error instanceof WeatherAiError && error.code === "invalidInterpretation"
  );
});

test("keeps a well-formed not-ready result for downstream fail-closed handling", async () => {
  const uncertain = structuredClone(interpretation);
  uncertain.ready = false;
  uncertain.confidence = "low";
  uncertain.observedDate = null;
  uncertain.slots[4] = { slot: "slot4", visible: false, weather: [], confidence: "low", description: "cropped" };
  uncertain.unresolved = ["date and slot4 are not visible"];
  const result = await interpretWeatherEvidence({
    capture,
    evidenceBytes: image,
    apiKey: "synthetic-key",
    fetchImpl: async () => responseFor(uncertain)
  });
  assert.equal(result.interpretation.ready, false);
  assert.deepEqual(result.interpretation.slots[4].weather, []);
});
