/**
 * Keyboard navigation tests (design section 8.4 acceptance): the primary nav,
 * sign-out, and skip link are reachable in tab order, and login completes
 * from the keyboard alone.
 */

import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FakeHttpClient } from "./fake-http-client";
import { renderWeb } from "./render";

describe("keyboard navigation", () => {
  it("reaches skip link, brand, nav links, and sign out in tab order", async () => {
    const fake = new FakeHttpClient();
    fake.preAuthenticate();
    const user = userEvent.setup();
    renderWeb(fake, { initialEntries: ["/"] });

    await screen.findByRole("heading", { name: "Dashboard" });

    const order: string[] = [];
    const capture = (): void => {
      const active = document.activeElement;
      const label =
        active?.getAttribute("aria-label") ??
        active?.textContent?.trim().split("\n")[0] ??
        active?.tagName ??
        "";
      if (label.length > 0) order.push(label);
    };

    // Skip link is the first focusable element.
    await user.tab();
    capture();
    expect(order[0]).toBe("Skip to content");

    // Brand link, then the two primary nav links, then sign out.
    await user.tab();
    capture();
    expect(order[1]).toContain("DumpLedger");
    await user.tab();
    capture();
    expect(order[2]).toBe("Cases");
    await user.tab();
    capture();
    expect(order[3]).toBe("Operations");
    await user.tab();
    capture();
    expect(order[4]).toBe("Sign out");
  });

  it("signs in entirely from the keyboard (auto-focused field, Enter submits)", async () => {
    const fake = new FakeHttpClient();
    const user = userEvent.setup();
    renderWeb(fake, { initialEntries: ["/login"] });

    // autoFocus lands keyboard users on the password field.
    const password = screen.getByLabelText("Operator password");
    expect(document.activeElement).toBe(password);

    await user.keyboard("correct horse battery staple");
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeTruthy();
  });

  it("moves focus to the error summary after a failed sign-in", async () => {
    const fake = new FakeHttpClient();
    const user = userEvent.setup();
    renderWeb(fake, { initialEntries: ["/login"] });

    const password = screen.getByLabelText("Operator password");
    await user.type(password, "wrong password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The operator password is incorrect.");
    // LoginPage moves focus to the focusable error summary region.
    const errorRegion = alert.closest(".auth-error");
    expect(errorRegion).not.toBeNull();
    await waitForFocus(errorRegion as HTMLElement);
  });
});

/** jsdom + React focus management can settle a frame late; wait for it. */
async function waitForFocus(element: HTMLElement): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (document.activeElement === element) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(document.activeElement).toBe(element);
}
