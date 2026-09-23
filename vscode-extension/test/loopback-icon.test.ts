import { afterEach, describe, expect, it, vi } from "vitest";
import { inlineIcon } from "../src/icon.js";

const SERVER = "https://api.example.xyz";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function stubFetch(body: Buffer, contentType = "image/png", ok = true) {
  const f = vi.fn(async () => new Response(body, { status: ok ? 200 : 404, headers: { "content-type": contentType } }));
  vi.stubGlobal("fetch", f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe("inlineIcon", () => {
  it("inlines an ad-server upload as a data: URI, refusing redirects", async () => {
    const f = stubFetch(PNG);
    await expect(inlineIcon(`${SERVER}/uploads/abc`, SERVER)).resolves.toBe(`data:image/png;base64,${PNG.toString("base64")}`);
    expect(f.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
  });

  it.each([
    ["another origin", "https://tracker.example/uploads/abc"],
    ["a non-upload path", `${SERVER}/ad/click?x=1`],
    ["plain http", "http://api.example.xyz/uploads/abc"],
    ["a private address", "https://192.168.1.1/uploads/abc"],
  ])("never fetches %s", async (_label, url) => {
    const f = stubFetch(PNG);
    await expect(inlineIcon(url, SERVER)).resolves.toBe("");
    expect(f).not.toHaveBeenCalled();
  });

  it("drops non-raster content and oversized images", async () => {
    stubFetch(Buffer.from("<svg/>"), "image/svg+xml");
    await expect(inlineIcon(`${SERVER}/uploads/a`, SERVER)).resolves.toBe("");
    stubFetch(Buffer.alloc(150_001), "image/png");
    await expect(inlineIcon(`${SERVER}/uploads/b`, SERVER)).resolves.toBe("");
  });
});
