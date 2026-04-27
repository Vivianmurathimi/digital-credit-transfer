require('dotenv').config();
const pool = require('./db');

const alterUsersTable = `
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_password_token VARCHAR(255);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_password_expires BIGINT;
`;

const init = async () => {
    try {
        console.log('⏳ Adding password reset columns...');
        await pool.query(alterUsersTable);
        console.log('✅ Users table updated successfully!');
    } catch (err) {
        console.error('❌ Error updating table:', err);
    } finally {
        pool.end();
    }
};

init();