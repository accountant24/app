import { describe, expect, test } from "vitest";
import { servedModelOk, splitModel } from "../models";

describe("splitModel()", () => {
  test("should split provider and model id", () => {
    expect(splitModel("openai/gpt-5.6-terra")).toEqual({ provider: "openai", id: "gpt-5.6-terra" });
  });

  test("should keep further slashes in the model id", () => {
    expect(splitModel("openrouter/deepseek/deepseek-v4-flash")).toEqual({
      provider: "openrouter",
      id: "deepseek/deepseek-v4-flash",
    });
  });

  test("should mean Anthropic for a bare model id", () => {
    expect(splitModel("claude-opus-5")).toEqual({ provider: "anthropic", id: "claude-opus-5" });
  });
});

describe("servedModelOk()", () => {
  test("should accept the exact requested model", () => {
    expect(servedModelOk("gpt-5.6-luna", "gpt-5.6-luna")).toBe(true);
  });

  test("should accept a dated snapshot in either date style", () => {
    expect(servedModelOk("claude-sonnet-5", "claude-sonnet-5-20260901")).toBe(true);
    expect(servedModelOk("gpt-5.6-luna", "gpt-5.6-luna-2026-08-15")).toBe(true);
  });

  test("should reject a different model that shares the prefix", () => {
    expect(servedModelOk("gpt-5.6", "gpt-5.6-luna")).toBe(false);
    expect(servedModelOk("claude-opus-5", "claude-opus-5-5")).toBe(false);
  });

  test("should treat dots in the requested id literally", () => {
    expect(servedModelOk("gpt-5.6-sol", "gpt-5x6-sol")).toBe(false);
  });
});
