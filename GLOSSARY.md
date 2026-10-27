# agent-service

The fleet's agent, ships and contracts, and the history of what moved credits. Workspace-wide terms are in `meta/GLOSSARY.md`.

## Language

**Transaction**:
A recorded credit-moving action of one type: `SHIP_PURCHASE`, `PURCHASE` (cargo), `SELL` (cargo). Written after the game confirms, best-effort (meta ADR 0001).
_Avoid_: trade, order

**Delivery**:
A recorded contract delivery, written by fleet-service after the game accepts it.
