export class SessionRunState {
  private generations = new Map<string, number>();

  begin(sessionId: string) {
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);
    return generation;
  }

  cancel(sessionId: string) {
    return this.begin(sessionId);
  }

  isCurrent(sessionId: string, generation: number) {
    return this.generations.get(sessionId) === generation;
  }
}

export const sessionRunState = new SessionRunState();
