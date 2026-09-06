/**
 * Shell session tests — login, logout, reload restore, deep link, and
 * 401/403 session semantics (design sections 6 and 8.2). Everything runs
 * through the real App/router component graph with a fake HTTP adapter.
 */

import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FakeHttpClient } from "./fake-http-client";
import { renderWeb } from "./render";

const VALID_PASSWORD = "correct horse battery staple";

async function signIn(user: ReturnType<typeof userEvent.setup>, password = VALID_PASSWORD): Promise<void> {
  const input = screen.getByLabelText("Operator password");
  await user.type(input, password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("login flow", () => {
  it("signs in with the operator password and lands on the dashboard", async () => {
    const fake = new FakeHttpClient();
    const user = userEvent.setup();
    renderWeb(fake, { initialEntries: ["/login"] });

    await signIn(user);

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeTruthy();
    expect(fake.authenticated).toBe(true);
    const sessionPosts = fake.calls.filter((call) => call.method === "POST" && call.path === "/api/v1/session");
    expect(sessionPosts).toHaveLength(1);
    expect(sessionPosts[0]).toMatchObject({ body: { password: VALID_PASSWORD } });
  });

  it("shows a safe error and stays on the login page when the password is wrong", async () => {
    const fake = new FakeHttpClient();
    const user = userEvent.setup();
    renderWeb(fake, { initialEntries: ["/login"] });

    await signIn(user, "not the password");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The operator password is incorrect.");
    expect(screen.getByRole("heading", { name: "Operator sign in" })).toBeTruthy();
    expect(fake.authenticated).toBe(false);
  });

  it("clears the submitted password and never retains it in the DOM after a failed attempt", async () => {
    const fake = new FakeHttpClient();
    const user = userEvent.setup();
    renderWeb(fake, { initialEntries: ["/login"] });

    await signIn(user, "wrong");
    await screen.findByRole("alert");
    const input = screen.getByLabelText("Operator password") as HTMLInputElement;
    expect(input.value).toBe("");
  });
});

describe("logout", () => {
  it("signs out through DELETE /api/v1/session with a CSRF token and returns to /login", async () => {
    const fake = new FakeHttpClient();
    fake.preAuthenticate();
    const user = userEvent.setup();
    renderWeb(fake, { initialEntries: ["/"] });

    await screen.findByRole("heading", { name: "Dashboard" });
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("heading", { name: "Operator sign in" })).toBeTruthy();
    expect(fake.authenticated).toBe(false);
    const deletes = fake.calls.filter((call) => call.method === "DELETE" && call.path === "/api/v1/session");
    expect(deletes).toHaveLength(1);
    // Mutations must carry the in-memory CSRF token.
    expect(deletes[0]?.csrfToken).toBe(fake.csrfToken);
  });
});

describe("reload session restore", () => {
  it("restores an authenticated session from GET /api/v1/session on a cold mount", async () => {
    const fake = new FakeHttpClient();
    fake.preAuthenticate();
    // Cold mount: SessionProvider starts in "checking", so a bootstrap request
    // is the first thing an operator route performs.
    renderWeb(fake, { initialEntries: ["/"] });

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeTruthy();
    const queries = fake.calls.filter((call) => call.kind === "query" && call.path === "/api/v1/session");
    expect(queries).toHaveLength(1);
  });
});

describe("deep links", () => {
  it("redirects an anonymous deep link to /login and returns to the original route after sign-in", async () => {
    const fake = new FakeHttpClient();
    const user = userEvent.setup();
    renderWeb(fake, { initialEntries: ["/cases/case-17"] });

    // OperatorGuard bootstraps, finds no session, and sends the operator to
    // /login retaining the safe relative return path.
    expect(await screen.findByRole("heading", { name: "Operator sign in" })).toBeTruthy();

    await signIn(user);

    // The operator returns to the original deep link.
    expect(await screen.findByRole("heading", { name: "Case detail" })).toBeTruthy();
    expect(screen.getByText("Case case-17")).toBeTruthy();
  });

  it("does not trigger a session bootstrap for a public deep link", async () => {
    const fake = new FakeHttpClient();
    renderWeb(fake, { initialEntries: ["/login"] });

    await screen.findByRole("heading", { name: "Operator sign in" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("expired session (401)", () => {
  it("clears the session and returns to /login when the server answers 401", async () => {
    const fake = new FakeHttpClient();
    fake.preAuthenticate();
    const user = userEvent.setup();
    renderWeb(fake, { initialEntries: ["/"] });
    await screen.findByRole("heading", { name: "Dashboard" });

    // The server has already dropped the session; the next state-changing
    // request answers 401 and the client's 401 handling clears the session.
    fake.expireSession();
    fake.deleteStatus = 401;
    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(await screen.findByRole("heading", { name: "Operator sign in" })).toBeTruthy();
    // No sign-out failure notice is shown: 401 means the server already
    // considered the session gone, so the shell just routes to /login.
    expect(screen.queryByText("Sign out failed.")).toBeNull();
  });

  it("treats an expired session on reload as anonymous and shows the login page", async () => {
    const fake = new FakeHttpClient();
    fake.sessionMode = "unauthorized";
    renderWeb(fake, { initialEntries: ["/operations"] });

    expect(await screen.findByRole("heading", { name: "Operator sign in" })).toBeTruthy();
  });
});

describe("403 stays visible", () => {
  it("keeps the operator on the page and shows an error when sign out is forbidden", async () => {
    const fake = new FakeHttpClient();
    fake.preAuthenticate();
    fake.deleteStatus = 403;
    const user = userEvent.setup();
    renderWeb(fake, { initialEntries: ["/"] });
    await screen.findByRole("heading", { name: "Dashboard" });

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    // A 403 is a visible authorization/CSRF error, not a logout. The notice
    // surfaces the server's safe message rather than the fallback text.
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Sign out is not permitted for this session.")).toBeTruthy();
    expect(fake.authenticated).toBe(true);
    expect(screen.getByRole("heading", { name: "Dashboard" })).toBeTruthy();
  });
});

describe("server unreachable during restore", () => {
  it("shows a retryable restore error instead of bouncing to /login", async () => {
    const fake = new FakeHttpClient();
    fake.sessionMode = "unreachable";
    renderWeb(fake, { initialEntries: ["/"] });

    expect(await screen.findByRole("heading", { name: "Cannot restore your session" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Operator sign in" })).toBeNull();

    // Recovering the server and pressing retry completes the restore.
    fake.sessionMode = "ok";
    fake.preAuthenticate();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeTruthy();
  });
});

