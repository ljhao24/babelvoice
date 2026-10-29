import type { Direction } from '@shared/ipc-types.js';
import type { DirectionSession } from './direction-session.js';

/**
 * Main-process registry of active DirectionSessions, keyed by Direction.
 * The interface stays narrow so callers don't grow affordances against the
 * Map shape.
 */
class SessionRegistry {
  private readonly slots = new Map<Direction, DirectionSession>();

  has(direction: Direction): boolean {
    return this.slots.has(direction);
  }

  get(direction: Direction): DirectionSession | undefined {
    return this.slots.get(direction);
  }

  set(direction: Direction, session: DirectionSession): void {
    this.slots.set(direction, session);
  }

  delete(direction: Direction): boolean {
    return this.slots.delete(direction);
  }

  get size(): number {
    return this.slots.size;
  }

  values(): DirectionSession[] {
    return Array.from(this.slots.values());
  }

  clear(): void {
    this.slots.clear();
  }

}

export const sessionRegistry = new SessionRegistry();
