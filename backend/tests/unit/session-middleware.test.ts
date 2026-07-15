import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { createSessionMiddleware } from "./session";
import { requireAuth } from "./require-auth";
import { NotAuthenticatedError } from "./pipeline-errors";
import { UserRecord, UserStore } from "../store/user-store";

const user: UserRecord = {
  googleUserId: "u1",
  email: "ada@example.com",
  spreadsheetId: "sheet-1",
  accessToken: "at",
  refreshToken: "rt",
  tokenExpiry: null,
  savedContactsCount: 0,
};

function fakeStore(found: UserRecord | null): UserStore {
  return {
    findById: vi.fn(async () => found),
    upsertOnLogin: vi.fn(),
    updateTokens: vi.fn(),
    setSpreadsheetId: vi.fn(),
    clearTokens: vi.fn(),
    incrementSavedContactsCount: vi.fn(async () => 1),
  };
}

describe("createSessionMiddleware", () => {
  it("populates req.auth for a valid signed cookie", async () => {
    const mw = createSessionMiddleware(fakeStore(user));
    const req = { signedCookies: { c2c_session: "u1" } } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, {} as Response, next);

    expect(req.auth).toEqual({ googleUserId: "u1", user });
    expect(next).toHaveBeenCalledWith();
  });

  it("leaves req.auth undefined when the cookie is missing", async () => {
    const mw = createSessionMiddleware(fakeStore(user));
    const req = { signedCookies: {} } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, {} as Response, next);

    expect(req.auth).toBeUndefined();
    expect(next).toHaveBeenCalledWith();
  });

  it("leaves req.auth undefined when the user no longer exists", async () => {
    const mw = createSessionMiddleware(fakeStore(null));
    const req = { signedCookies: { c2c_session: "ghost" } } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;

    await mw(req, {} as Response, next);

    expect(req.auth).toBeUndefined();
  });
});

describe("requireAuth", () => {
  it("passes through when req.auth is present", () => {
    const req = { auth: { googleUserId: "u1", user } } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;
    requireAuth(req, {} as Response, next);
    expect(next).toHaveBeenCalledWith();
  });

  it("errors with NotAuthenticatedError when req.auth is absent", () => {
    const req = {} as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;
    requireAuth(req, {} as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(NotAuthenticatedError));
  });
});
