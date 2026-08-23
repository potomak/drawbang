import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { authModeView, buildAuthRequest } from "../src/publish-dialog.js";

// The DOM wiring in createPublishDialog isn't exercised here (same as
// export-dialog.test.ts) — these cover the mode/field logic behind it,
// which is where the breakable decisions live.

describe("authModeView", () => {
  test("signup requires a username; login does not", () => {
    assert.equal(authModeView("signup").usernameRequired, true);
    assert.equal(authModeView("login").usernameRequired, false);
  });

  test("password autocomplete matches the mode", () => {
    // Wrong hints here make password managers offer to overwrite a saved
    // password on login, or autofill the old one into a new account.
    assert.equal(authModeView("login").passwordAutocomplete, "current-password");
    assert.equal(authModeView("signup").passwordAutocomplete, "new-password");
  });

  test("submit label names both what happens and that publishing follows", () => {
    assert.match(authModeView("login").submitLabel, /Log in .*publish/);
    assert.match(authModeView("signup").submitLabel, /Sign up .*publish/);
  });
});

describe("buildAuthRequest", () => {
  test("login sends only email + password", () => {
    const req = buildAuthRequest("login", {
      email: "a@b.com",
      username: "ignored",
      password: "password123",
    });
    assert.deepEqual(req, { kind: "login", email: "a@b.com", password: "password123" });
  });

  test("signup lowercases and trims the username", () => {
    // USERNAME_RE only admits lowercase, so an uppercase handle typed here
    // would 400 server-side without this.
    const req = buildAuthRequest("signup", {
      email: "a@b.com",
      username: "  AliceDraws  ",
      password: "password123",
    });
    assert.deepEqual(req, {
      kind: "signup",
      email: "a@b.com",
      username: "alicedraws",
      password: "password123",
    });
  });

  test("email is trimmed in both modes", () => {
    assert.equal(
      buildAuthRequest("login", { email: " a@b.com ", username: "", password: "x" }).email,
      "a@b.com"
    );
    assert.equal(
      buildAuthRequest("signup", { email: " a@b.com ", username: "u", password: "x" }).email,
      "a@b.com"
    );
  });

  test("passwords are passed through untouched, including surrounding spaces", () => {
    // Trimming a password silently changes the user's secret — it would
    // register one string and then fail to log in with the same input.
    const padded = "  spaced pass  ";
    assert.equal(
      buildAuthRequest("login", { email: "a@b.com", username: "", password: padded }).password,
      padded
    );
    assert.equal(
      buildAuthRequest("signup", { email: "a@b.com", username: "u", password: padded }).password,
      padded
    );
  });
});
