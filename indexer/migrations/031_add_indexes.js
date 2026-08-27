exports.up = async (pgm) => {
  pgm.createIndex('events', 'contract_id');
  pgm.createIndex('events', 'function');
  pgm.createIndex('events', 'ledger');
  pgm.createIndex('events', 'caller_address');
};

exports.down = async (pgm) => {
  pgm.dropIndex('events', 'contract_id');
  pgm.dropIndex('events', 'function');
  pgm.dropIndex('events', 'ledger');
  pgm.dropIndex('events', 'caller_address');
};
