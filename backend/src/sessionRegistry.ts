import { Session } from "./session.js";

export class SessionRegistry {
  private theOne: Session | null = null;
  /** Phase 2a: a single shared session, created on first use. */
  only(): Session {
    if (!this.theOne) this.theOne = new Session();
    return this.theOne;
  }
  closeAll(): void { this.theOne?.close(); this.theOne = null; }
}
