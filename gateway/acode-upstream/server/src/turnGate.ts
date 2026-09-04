export type TurnAdmission = "accepted" | "duplicate" | "busy";

/** Serializes top-level turn starts per Codex thread and recognizes retries of
 * an already accepted client request. Interjections use a separate endpoint. */
export class TurnGate {
  private readonly activeSessions = new Set<string>();

  acquire(sessionId: string, clientRequestId?: string, persistedRequestId?: string): TurnAdmission {
    if (clientRequestId && clientRequestId === persistedRequestId) return "duplicate";
    if (this.activeSessions.has(sessionId)) return "busy";
    this.activeSessions.add(sessionId);
    return "accepted";
  }

  release(sessionId: string) {
    this.activeSessions.delete(sessionId);
  }

  isActive(sessionId: string) {
    return this.activeSessions.has(sessionId);
  }
}

export const turnGate = new TurnGate();
