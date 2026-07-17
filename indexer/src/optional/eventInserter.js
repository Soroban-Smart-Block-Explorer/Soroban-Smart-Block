class EventInserter {
  constructor(db, logger) {
    this.db = db;
    this.logger = logger;
  }

  async insertEvents(events, correlationId) {
    const query = `
      INSERT INTO events (contract_id, function, ledger, tx_hash, caller_address, decoded_value, raw_value)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (contract_id, ledger, tx_hash) DO NOTHING
      RETURNING id
    `;

    let inserted = 0;
    let duplicates = 0;

    for (const event of events) {
      try {
        const result = await this.db.query(query, [
          event.contract_id,
          event.function,
          event.ledger,
          event.tx_hash,
          event.caller_address,
          JSON.stringify(event.decoded_value),
          event.raw_value,
        ]);

        if (result.rows.length === 0) {
          duplicates++;
        } else {
          inserted++;
        }
      } catch (err) {
        this.logger.error({ correlationId, error: err.message, event }, 'Failed to insert event');
      }
    }

    if (duplicates > 0) {
      this.logger.info({ correlationId, duplicates }, 'Duplicate events skipped');
    }

    return { inserted, duplicates };
  }
}

module.exports = EventInserter;
