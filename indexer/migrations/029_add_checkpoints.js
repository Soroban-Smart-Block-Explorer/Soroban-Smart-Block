exports.up = async (pgm) => {
  pgm.createTable('checkpoints', {
    id: { type: 'serial', primaryKey: true },
    ledger_sequence: { type: 'bigint', notNull: true, unique: true },
    checkpoint_time: { type: 'timestamp', default: pgm.func('now()') },
  });

  pgm.createIndex('checkpoints', 'ledger_sequence');
};

exports.down = async (pgm) => {
  pgm.dropTable('checkpoints');
};
