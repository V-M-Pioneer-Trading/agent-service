# History is written best-effort after the game confirms

A credit-moving action calls the game first and writes its history row (transaction, delivery record) only after the game confirms; a failed write is logged, never retried, and never fails the response. The game action is irreversible, so failing the response would invite a repeat purchase. The cost: history can be incomplete, with no outbox or reconciliation.

Source: `README.md#A credit-moving action, end to end`; `README.md#Known limitations`
