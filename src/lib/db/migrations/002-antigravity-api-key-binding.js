const migration = {
  version: 2,
  name: "antigravity-api-key-binding",
  up(db) {
    const columns = db.all(`PRAGMA table_info(apiKeys)`);
    if (!columns.some((column) => column.name === "providerConnectionId")) {
      db.exec(`ALTER TABLE apiKeys ADD COLUMN providerConnectionId TEXT`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_ak_provider_connection
      ON apiKeys(providerConnectionId) WHERE providerConnectionId IS NOT NULL`);
  },
};

export default migration;
