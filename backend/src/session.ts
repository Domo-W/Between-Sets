import type WebSocket from "ws";
import type { ServerMsg } from "./types.js";
import { Tug } from "./tug.js";
import { Participants } from "./participants.js";
import { Vibes } from "./vibes.js";
import { Room } from "./room.js";
import { Sim } from "./sim.js";
import { ShowMachine } from "./showMachine.js";

export class Session {
  readonly sockets = new Set<WebSocket>();
  readonly tug = new Tug();
  readonly participants = new Participants();
  readonly vibes = new Vibes();
  readonly room: Room;
  readonly sim: Sim;
  readonly show: ShowMachine;
  lastActivity = Date.now();

  constructor() {
    const broadcast = (msg: ServerMsg) => this.broadcast(msg);
    this.room = new Room(broadcast);
    this.sim = new Sim({ broadcast, participants: this.participants, room: this.room, tug: this.tug });
    this.show = new ShowMachine({
      broadcast, room: this.room, sim: this.sim,
      participants: this.participants, vibes: this.vibes, tug: this.tug,
    });
  }

  broadcast(msg: ServerMsg): void {
    const raw = JSON.stringify(msg);
    for (const ws of this.sockets) {
      // ws OPEN === 1; avoid importing the WS runtime enum here
      if ((ws as unknown as { readyState: number }).readyState === 1) {
        (ws as unknown as { send: (d: string) => void }).send(raw);
      }
    }
  }

  addSocket(ws: WebSocket): void { this.sockets.add(ws); this.lastActivity = Date.now(); }
  removeSocket(ws: WebSocket): void { this.sockets.delete(ws); }

  close(): void {
    this.show.stop();   // clears all show timers (gather/buzzer/stall/tug/names)
    this.room.close();  // clears the empty-lobby timer
    this.sockets.clear();
  }
}
