require('dotenv').config();
const pool = require('./db');

const alterUsersTable = `
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verification_token VARCHAR(255);
`;

const init = async () => {
    try {
        console.log('⏳ Updating users table with verification columns...');
        await pool.query(alterUsersTable);
        console.log('✅ Users table updated successfully!');
    } catch (err) {
        console.error('❌ Error updating table:', err);
    } finally {
        pool.end();
    }
};

init();