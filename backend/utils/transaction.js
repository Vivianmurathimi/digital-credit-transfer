const pool = require('../db');

/**
 * Runs work(client) inside one database transaction: either everything it saves is kept,
 * or (on any error) nothing is. Returns what work returns.
 */
const inTransaction = async (work) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
};

module.exports = inTransaction;
