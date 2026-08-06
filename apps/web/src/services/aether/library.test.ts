import { describe, expect, it } from "vitest";
import {
  findById,
  resolveAnimations,
  resolveLibraryPath,
  resolveModels,
  type AssetLibraryCatalog,
} from "@aether/studio";

const catalog: AssetLibraryCatalog = {
  version: 1,
  credit: "test",
  models: [
    {
      id: "product-ani",
      label: "Ani",
      path: "../avatar.vrm",
      tags: ["default"],
    },
  ],
  animations: [
    {
      id: "vrma-02",
      label: "Greeting",
      path: "animations/VRMA_02_greeting.vrma",
      suggestedSlot: "idle",
    },
  ],
};

const catalogUrl = "http://test.local/assets/aether/library/catalog.json";

describe("aether library resolve", () => {
  it("resolves relative model path against catalog URL", () => {
    const models = resolveModels(catalog, catalogUrl);
    expect(models[0]?.id).toBe("product-ani");
    expect(models[0]?.url).toBe("http://test.local/assets/aether/avatar.vrm");
  });

  it("resolves animation paths", () => {
    const anims = resolveAnimations(catalog, catalogUrl);
    expect(anims[0]?.url).toContain("VRMA_02_greeting.vrma");
    expect(anims[0]?.suggestedSlot).toBe("idle");
  });

  it("findById returns model or animation", () => {
    expect(findById(catalog, catalogUrl, "product-ani")?.kind).toBe("model");
    expect(findById(catalog, catalogUrl, "vrma-02")?.kind).toBe("animation");
    expect(findById(catalog, catalogUrl, "nope")).toBeNull();
  });

  it("resolveLibraryPath joins URL", () => {
    expect(
      resolveLibraryPath(catalogUrl, "animations/x.vrma"),
    ).toBe("http://test.local/assets/aether/library/animations/x.vrma");
  });
});
