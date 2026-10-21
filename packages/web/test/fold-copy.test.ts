// Not covered: drawing the callout. Both fold layouts print copy.split.lineTwo as given, and nothing renders here.
import { describe, expect, it } from "vitest";
import { foldCopy, leftoverLine } from "@/components/cinema/fold-static";
import { sampleTripStory } from "@/lib/sample-trip-story";

describe("the fold's leftover-cent callout", () => {
  it("counts the dinner's two leftover cents from the story", () => {
    const copy = foldCopy(sampleTripStory());

    expect(copy.split?.lineOne).toBe("DINNER AT TABERNA 96.50 EUR → ANA 32.17 · BEN 32.17 · CY 32.16");
    expect(copy.split?.lineTwo).toBe("The two leftover cents go to the first two people listed.");
  });

  it("uses the singular for one leftover cent and a counted plural for more", () => {
    expect(leftoverLine([{ base: "10.01" }, { base: "10.00" }, { base: "10.00" }])).toBe(
      "The leftover cent goes to the first person listed.",
    );
    expect(leftoverLine([{ base: "10.69" }, { base: "10.69" }, { base: "10.69" }, { base: "10.68" }])).toBe(
      "The three leftover cents go to the first three people listed.",
    );
  });
});
