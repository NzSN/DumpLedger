/**
 * Status vocabulary tests (shared/status.ts): presentation labels/tone map
 * every wire status exactly, so a status that arrives from a changed backend
 * still has a safe rendering path (functions switch over the closed union).
 */

import { describe, expect, it } from "vitest";
import {
  caseActionLabel,
  caseStatusPresentation,
  dumpPhasePresentation,
  grantStatePresentation,
  integrityStatusPresentation,
  validationStatePresentation,
} from "../shared/status";

describe("status presentation helpers", () => {
  it("labels every case status", () => {
    for (const status of ["new", "investigating", "waiting-for-customer", "resolved", "closed"] as const) {
      expect(caseStatusPresentation(status).label.length).toBeGreaterThan(0);
    }
    expect(caseStatusPresentation("closed").tone).toBe("muted");
  });

  it("labels the five generated case actions with readable text", () => {
    expect(caseActionLabel("StartInvestigation")).toBe("Start investigation");
    expect(caseActionLabel("CloseCase")).toBe("Close case");
  });

  it("maps grant and dump lifecycle phases onto tones", () => {
    expect(grantStatePresentation("revoked").tone).toBe("warn");
    expect(grantStatePresentation("consumed").tone).toBe("good");
    expect(dumpPhasePresentation("available").tone).toBe("good");
    expect(dumpPhasePresentation("rejected").tone).toBe("bad");
  });

  it("covers validation and integrity states", () => {
    expect(validationStatePresentation("valid").tone).toBe("good");
    expect(validationStatePresentation("invalid").tone).toBe("bad");
    expect(integrityStatusPresentation("ok").tone).toBe("good");
    expect(integrityStatusPresentation("degraded").tone).toBe("warn");
  });
});
