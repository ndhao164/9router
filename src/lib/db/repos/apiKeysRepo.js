import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";

function rowToKey(row) {
  if (!row) return null;
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    machineId: row.machineId,
    providerConnectionId: row.providerConnectionId || null,
    isActive: row.isActive === 1 || row.isActive === true,
    createdAt: row.createdAt,
  };
}

export async function getApiKeys() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM apiKeys ORDER BY createdAt ASC`);
  return rows.map(rowToKey);
}

export async function getApiKeyById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
  return rowToKey(row);
}

export async function getApiKeyByValue(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM apiKeys WHERE key = ?`, [key]);
  return rowToKey(row);
}

export async function createApiKey(name, machineId, providerConnectionId = null) {
  if (!machineId) throw new Error("machineId is required");
  const db = await getAdapter();
  const binding = providerConnectionId ? String(providerConnectionId).trim() : null;
  const { generateApiKeyWithMachine } = await import("@/shared/utils/apiKey");
  const result = generateApiKeyWithMachine(machineId);
  const apiKey = {
    id: uuidv4(), name, key: result.key, machineId,
    providerConnectionId: binding, isActive: true, createdAt: new Date().toISOString(),
  };
  db.transaction(() => {
    if (binding) {
      const connection = db.get(`SELECT provider FROM providerConnections WHERE id = ?`, [binding]);
      if (!connection || connection.provider !== "antigravity") {
        const error = new Error("Antigravity account not found");
        error.code = "INVALID_ANTIGRAVITY_CONNECTION";
        throw error;
      }
      if (db.get(`SELECT id FROM apiKeys WHERE providerConnectionId = ?`, [binding])) {
        const error = new Error("This Antigravity account already has an API key");
        error.code = "ANTIGRAVITY_KEY_EXISTS";
        throw error;
      }
    }
    db.run(
      `INSERT INTO apiKeys(id, key, name, machineId, providerConnectionId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      [apiKey.id, apiKey.key, apiKey.name, apiKey.machineId, binding, 1, apiKey.createdAt]
    );
  });
  return apiKey;
}

export async function updateApiKey(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM apiKeys WHERE id = ?`, [id]);
    if (!row) return;
    const merged = { ...rowToKey(row), ...data };
    db.run(
      `UPDATE apiKeys SET key = ?, name = ?, machineId = ?, providerConnectionId = ?, isActive = ? WHERE id = ?`,
      [merged.key, merged.name, merged.machineId, merged.providerConnectionId, merged.isActive ? 1 : 0, id]
    );
    result = merged;
  });
  return result;
}

export async function deleteApiKey(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM apiKeys WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}

export async function validateApiKey(key) {
  const db = await getAdapter();
  const row = db.get(`SELECT isActive FROM apiKeys WHERE key = ?`, [key]);
  if (!row) return false;
  return row.isActive === 1 || row.isActive === true;
}
