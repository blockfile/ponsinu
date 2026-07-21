'use strict';

const { MongoClient } = require('mongodb');

let client = null;
let db = null;

/** Connect once and create indexes. Safe to call repeatedly (idempotent). */
async function connect() {
  if (db) return db;
  // Resolve config at call time (not module load) so a test that reloads the
  // config module (fresh MONGODB_URI per in-memory server) connects to the
  // CURRENT URI instead of a stale one captured at first require.
  const config = require('../config');
  client = new MongoClient(config.mongoUri);
  await client.connect();
  db = client.db(config.mongoDb);

  await Promise.all([
    db.collection('cycles').createIndex({ id: 1 }, { unique: true }),
    db.collection('steps').createIndex({ id: 1 }, { unique: true }),
    db.collection('steps').createIndex({ cycle_id: 1 }),
  ]);

  return db;
}

function getDb() {
  if (!db) throw new Error('MongoDB not connected — call connect() first');
  return db;
}

async function close() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

module.exports = { connect, getDb, close };
