import type { MicReport } from "./protocol";

/** The panel's mic report as one log line: numbers, flags and the device's name, nothing anyone said. */
export function micLine(report: unknown): string {
  const r = (report ?? {}) as Record<string, unknown>;
  const n = (key: string) => (typeof r[key] === "number" && Number.isFinite(r[key]) ? Math.round(r[key] * 10) / 10 : "?");
  const flag = (key: string) => (r[key] === true ? "on" : r[key] === false ? "off" : "?");
  const device = typeof r.device === "string" ? r.device.replace(/[^\p{L}\p{N} ()._:-]/gu, "").slice(0, 80) : "";
  const frames = typeof r.frames === "number" && Number.isFinite(r.frames) ? Math.max(0, Math.round(r.frames)) : 0;
  const openShare = frames ? `${Math.round(((Number(r.openFrames) || 0) / frames) * 100)}%` : "?";
  return (
    `mic "${device || "unnamed"}" echo ${flag("echoCancellation")}, noise ${flag("noiseSuppression")}, gain ${flag("autoGainControl")}; ` +
    `gate opened ${n("opens")} times (${n("strictOpens")} while Phreak spoke), open ${openShare} of ${frames} frames, ` +
    `${n("rejected")} sounds kept out, ${n("relearned")} steady sounds relearned; ` +
    `floor ${n("firstFloorDb")} dB at start, ${n("floorDb")} now, ${n("maxFloorDb")} highest; ` +
    `loudest kept out ${n("noisePeakDb")} dB, loudest passed ${n("speechPeakDb")} dB`
  );
}

/** A pasteable handoff for the last attempt, including failures before the server accepted it. */
export function sessionDebug(threadId: string, started: Date, sessionId: string | null, reason: string, error: string | null, mic?: MicReport): string {
  const lines = [
    "Phreak voice session",
    `Thread: ${threadId}`,
    `Browser: ${navigator.userAgent}`,
    `Started: ${started.toISOString()}`,
    `Ended: ${new Date().toISOString()}`,
    `Reason: ${reason.slice(0, 1000)}`,
  ];
  if (error && error !== reason) lines.push(`Last error: ${error.slice(0, 1000)}`);
  if (mic && (mic.device || mic.frames)) lines.push(micLine(mic));
  if (sessionId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) {
    lines.push(`Session: ${sessionId}`, `On the bb host: bb plugin logs phreak -n 1000 | grep -F 'session ${sessionId}'`);
  } else {
    lines.push("The panel received no server session ID.");
  }
  return lines.join("\n");
}
