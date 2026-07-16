import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { errorHandler } from "../../../src/shared/http/error-handler";
import { UserDisabledError } from "../../../src/shared/http/pipeline-errors";
import { UserNotFoundError } from "../../../src/modules/admin-users/admin-users.service";

function app() {
  const a = express();
  a.get("/disabled", () => {
    throw new UserDisabledError();
  });
  a.get("/not-found", () => {
    throw new UserNotFoundError();
  });
  a.use(errorHandler);
  return a;
}

describe("errorHandler — Admin User Management errors", () => {
  it("403s UserDisabledError with code USER_DISABLED", async () => {
    const res = await request(app()).get("/disabled");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "This account has been disabled", code: "USER_DISABLED" });
  });

  it("404s UserNotFoundError with code USER_NOT_FOUND", async () => {
    const res = await request(app()).get("/not-found");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "User not found", code: "USER_NOT_FOUND" });
  });
});
