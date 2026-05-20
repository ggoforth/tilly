// Authoritative real-time record of "which farmer is sitting on which
// action space right now." Built from `placeFarmer` notifications because
// `gamedatas.meeples[i].location` lags the actual placement by SECONDS to
// TENS OF SECONDS — verified against the captured corpus where one of my
// own placeFarmer notifications didn't show in `meeples[].location` until
// 33 seconds and four gamestate transitions later. The notification, in
// contrast, fires synchronously with the click and carries `args.card.id`,
// `args.card.name`, and `args.player_id` deterministically.
//
// The probe owns one instance for the lifetime of an attach. The settler-
// driven distill consumes its snapshot to populate `actionBoard[].takenBy`
// and `me.placedFarmersThisRound`. Tests should call methods directly;
// runtime code wires this into `emitNotification` and probe attach.

export interface Placement {
  /** Action card id, e.g. "ActionReedBank" — meeple.location uses this too. */
  cardId: string;
  /** Display name from the placeFarmer notification args (e.g. "Reed Bank"). */
  cardName: string;
  /** String form of args.player_id (BGA sometimes sends numbers, sometimes
   *  strings — normalize at the boundary). */
  pId: string;
}

export class PlacementTracker {
  // cardId → Placement. One placement per card (BGA won't double-place).
  private map = new Map<string, Placement>();

  /** A `placeFarmer` notification arrived. Idempotent on the (cardId,pId)
   *  pair so a duplicate notification (rare but observed during reconnects)
   *  doesn't corrupt the map. */
  onPlaceFarmer(cardId: string, cardName: string, pId: string): void {
    if (!cardId || !pId) return;
    this.map.set(cardId, { cardId, cardName: cardName || cardId, pId });
  }

  /** A `returnHome` notification arrived — round is over, farmers return.
   *  Wipes the map; the next placeFarmer starts a fresh round. */
  onReturnHome(): void {
    this.map.clear();
  }

  /** Probe just attached (or re-attached after SPA-nav). Seed from any
   *  placements that DO show in gamedatas.meeples already — covers the
   *  mid-round reload case where we missed the live placeFarmer burst.
   *  `getCardName` lets us resolve the display name from `gamedatas.cards`. */
  seedFromMeeples(
    meeples: ReadonlyArray<{ type?: string; location?: string; pId?: string }>,
    getCardName: (cardId: string) => string,
  ): void {
    for (const m of meeples) {
      if (m?.type !== 'farmer') continue;
      const loc = m.location ?? '';
      if (!loc || loc === 'board' || loc === 'reserve') continue;
      const pid = m.pId != null ? String(m.pId) : '';
      if (!pid) continue;
      // Don't overwrite a tracker entry that already came from a live
      // notification (it's strictly fresher than the meeple snapshot).
      if (this.map.has(loc)) continue;
      this.map.set(loc, { cardId: loc, cardName: getCardName(loc) || loc, pId: pid });
    }
  }

  /** Hard reset on detach / navigation away. */
  reset(): void {
    this.map.clear();
  }

  /** Snapshot: cardId → placement. Use `.get()` for individual lookup;
   *  the returned Map is the live internal store, do not mutate. */
  view(): ReadonlyMap<string, Placement> {
    return this.map;
  }

  /** Names of action cards a given player has farmers on right now. */
  placementsForPlayer(pId: string): string[] {
    const out: string[] = [];
    for (const p of this.map.values()) {
      if (p.pId === pId) out.push(p.cardName);
    }
    return out;
  }
}
