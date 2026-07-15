import { describe, expect, it } from "vitest";
import {
  classifyGoogleError,
  SheetNotFoundError,
} from "../../src/modules/google-sheets/google-sheets.client";
import { ReauthRequiredError } from "../../src/shared/http/pipeline-errors";

/**
 * `classifyGoogleError` is the single normalization point that turns
 * provider-specific gaxios/googleapis errors into our domain errors, so the
 * service layer never inspects Google shapes. It always throws (return type
 * `never`); these tests assert which domain error comes out for each input.
 */
describe("classifyGoogleError", () => {
  it("maps a numeric 404 code to SheetNotFoundError", () => {
    expect(() => classifyGoogleError({ code: 404 })).toThrow(SheetNotFoundError);
  });

  it("maps response.status 404 to SheetNotFoundError", () => {
    expect(() => classifyGoogleError({ response: { status: 404 } })).toThrow(SheetNotFoundError);
  });

  it("maps a string '404' code to SheetNotFoundError", () => {
    expect(() => classifyGoogleError({ code: "404" })).toThrow(SheetNotFoundError);
  });

  it("maps a 401 to ReauthRequiredError", () => {
    expect(() => classifyGoogleError({ code: 401 })).toThrow(ReauthRequiredError);
  });

  it("maps an OAuth invalid_grant body to ReauthRequiredError", () => {
    expect(() =>
      classifyGoogleError({ response: { data: { error: "invalid_grant" } } }),
    ).toThrow(ReauthRequiredError);
  });

  it("rethrows an unrecognized error unchanged", () => {
    const original = new Error("some 500");
    expect(() => classifyGoogleError(original)).toThrow(original);
  });

  it("rethrows a 500 status unchanged (not one of the recoverable cases)", () => {
    const err = { response: { status: 500 } };
    let thrown: unknown;
    try {
      classifyGoogleError(err);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(err);
    expect(thrown).not.toBeInstanceOf(SheetNotFoundError);
    expect(thrown).not.toBeInstanceOf(ReauthRequiredError);
  });
});
