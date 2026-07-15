import { describe, expect, it, vi } from "vitest";

/**
 * Mistral OCR's `markdown` field is genuinely Markdown — it renders detected
 * images/logos as `![alt](src)` and stylized/large card text as `**bold**` or
 * `*italic*`. MistralOcrClient must strip that syntax before handing rawText
 * to M3, whose line-based parser expects plain text (see M3's known bug where
 * an image-ref line leaked into the "name" field, and bold asterisks leaked
 * into "company").
 */

let processMock: ReturnType<typeof vi.fn>;

vi.mock("@mistralai/mistralai", () => ({
  Mistral: vi.fn().mockImplementation(() => ({
    ocr: { process: processMock },
  })),
}));

async function recognizeWithPages(pages: Array<{ markdown: string }>) {
  const { MistralOcrClient } = await import(
    "../../src/modules/text-recognition/text-recognition.client"
  );
  processMock = vi.fn(async () => ({ pages }));
  const client = new MistralOcrClient("test-key");
  return client.recognize(Buffer.from("fake-image"));
}

describe("MistralOcrClient.recognize", () => {
  it("drops image reference markdown entirely", async () => {
    const text = await recognizeWithPages([
      { markdown: "![img-0.jpeg](img-0.jpeg)\nSonia Arora\nBranch Head" },
    ]);
    expect(text).toBe("Sonia Arora\nBranch Head");
  });

  it("unwraps bold markdown to plain text", async () => {
    const text = await recognizeWithPages([{ markdown: "**Infinity**\nFlower Boutique" }]);
    expect(text).toBe("Infinity\nFlower Boutique");
  });

  it("unwraps italic markdown to plain text", async () => {
    const text = await recognizeWithPages([{ markdown: "*Infinity*" }]);
    expect(text).toBe("Infinity");
  });

  it("keeps link text but drops the URL", async () => {
    const text = await recognizeWithPages([{ markdown: "[Acme Inc](https://acme.com)" }]);
    expect(text).toBe("Acme Inc");
  });

  it("strips heading markers", async () => {
    const text = await recognizeWithPages([{ markdown: "# Sonia Arora" }]);
    expect(text).toBe("Sonia Arora");
  });

  it("leaves plain text untouched", async () => {
    const text = await recognizeWithPages([
      { markdown: "Sonia Arora\nBranch Head\nsonia.a@mail.web" },
    ]);
    expect(text).toBe("Sonia Arora\nBranch Head\nsonia.a@mail.web");
  });
});
