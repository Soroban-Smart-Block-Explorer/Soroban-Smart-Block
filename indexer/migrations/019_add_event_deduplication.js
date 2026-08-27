exports.up = async (pgm) => {
  pgm.addConstraint('events', 'unique_event_dedup', {
    unique: ['contract_id', 'ledger', 'tx_hash'],
  });
};

exports.down = async (pgm) => {
  pgm.dropConstraint('events', 'unique_event_dedup');
};
