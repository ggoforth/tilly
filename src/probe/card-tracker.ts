// Authoritative real-time record of "which cards each player has built /
// played" in the current game. Built from buyCard / playOccupation /
// playImprovement / playCard notifications because
// `gamedatas.playerCards[i].location === 'inPlay'` lags the purchase by
// SECONDS — verified against a live R6→R7 trace where the user bought a
// Fireplace via the Improvements space and 30+ seconds (and many
// gamestate transitions) later the briefing's `me.played` was still
// empty. Without this tracker the LLM keeps recommending cards the user
// has already built. The notification, in contrast, fires synchronously
// with the click and carries the card id + name + player_id.
//
// The probe owns one instance for the lifetime of an attach. The settler-
// driven distill consumes its snapshot to augment / replace each
// player's `played[]` list. Tests should call methods directly; runtime
// code wires this into `emitNotification` and `attach()`.

export interface OwnedCard {
  /** Canonical card id (e.g. "Major_Fireplace1", "B102_Consultant"). */
  cardId: string;
  /** Display name from the notification args ("Fireplace", "Consultant").
   *  May fall back to cardId if the notification didn't carry a name. */
  cardName: string;
  /** Owner player id, normalized to string. BGA sometimes sends numbers
   *  and sometimes strings depending on the notification path. */
  pId: string;
}

export class CardTracker {
  // pId → Map<cardId, OwnedCard>. Two levels of map keyed for fast lookup
  // and idempotent inserts (a duplicate notification for the same card
  // doesn't corrupt the state).
  private byPlayer = new Map<string, Map<string, OwnedCard>>();

  /** A buy/play notification arrived. Idempotent on (pId, cardId) — a
   *  duplicate notification (rare but observed on reconnects) doesn't
   *  inflate the list. */
  onCardOwned(pId: string, cardId: string, cardName: string): void {
    if (!pId || !cardId) return;
    let m = this.byPlayer.get(pId);
    if (!m) {
      m = new Map();
      this.byPlayer.set(pId, m);
    }
    m.set(cardId, { cardId, cardName: cardName || cardId, pId });
  }

  /** Snapshot of all cards owned by a given player. Read-only — callers
   *  should treat this as immutable. */
  cardsForPlayer(pId: string): readonly OwnedCard[] {
    const m = this.byPlayer.get(pId);
    return m ? Array.from(m.values()) : [];
  }

  /** ReadonlyMap<pId, OwnedCard[]> view for cross-boundary passing to the
   *  distiller. Mirrors PlacementTracker.view() so the runtime wiring
   *  pattern stays uniform. */
  view(): ReadonlyMap<string, readonly OwnedCard[]> {
    const out = new Map<string, readonly OwnedCard[]>();
    for (const [pid, m] of this.byPlayer) {
      out.set(pid, Array.from(m.values()));
    }
    return out;
  }

  /** Probe just attached (or re-attached after SPA-nav). Seed from any
   *  cards that DO show in gamedatas.playerCards already — covers the
   *  mid-game reload case where we missed the live buyCard burst. */
  seedFromPlayerCards(
    playerCards: ReadonlyArray<{
      id?: string;
      pId?: string | number;
      location?: string;
    }>,
  ): void {
    for (const c of playerCards) {
      if (c?.location === 'inPlay' && c.id && c.pId != null) {
        this.onCardOwned(String(c.pId), String(c.id), '');
      }
    }
  }

  /** Probe detach — wipe all tracked ownership. */
  reset(): void {
    this.byPlayer.clear();
  }
}
