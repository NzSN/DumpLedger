/**
 * Routing shell tests — not-found handling, public-route isolation, and
 * client-side navigation between operator screens (design section 6).
 */

import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FakeHttpClient } from "./fake-http-client";
import { renderWeb } from "./render";

describe("not-found route", () => {
  it("renders the branded not-found view for an unknown browser route", async () => {
    const fake = new FakeHttpClient();
    renderWeb(fake, { initialEntries: ["/does/not/exist"] });

    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Go to the operator sign in/ })).toBeTruthy();
    // The public not-found view never triggers a session bootstrap.
    expect(fake.calls).toHaveLength(0);
  });
});

describe("client-side navigation", () => {
  it("navigates between operator routes through the primary navigation", async () => {
    const fake = new FakeHttpClient();
    fake.preAuthenticate();
    const user = userEvent.setup();
    renderWeb(fake, { initialEntries: ["/"] });

    await screen.findByRole("heading", { name: "Dashboard" });
    await user.click(screen.getByRole("link", { name: "Operations" }));

    expect(await screen.findByRole("heading", { name: "Operations" })).toBeTruthy();
  });

  it("keeps the authenticated session across client-side navigation", async () => {
    const fake = new FakeHttpClient();
    fake.preAuthenticate();
    const user = userEvent.setup();
    renderWeb(fake, { initialEntries: ["/"] });

    await screen.findByRole("heading", { name: "Dashboard" });
    const bootstraps = fake.calls.filter((call) => call.kind === "query" && call.path === "/api/v1/session");
    await user.click(screen.getByRole("link", { name: "Operations" }));
    await screen.findByRole("heading", { name: "Operations" });

    // No second bootstrap happened: the in-memory session carried over.
    const after = fake.calls.filter((call) => call.kind === "query" && call.path === "/api/v1/session");
    expect(after).toHaveLength(bootstraps.length);
  });
});
