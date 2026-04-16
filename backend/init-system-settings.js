require('dotenv').config();
const pool = require('./db');

const createTableQuery = `
    CREATE TABLE IF NOT EXISTS system_settings (
        id SERIAL PRIMARY KEY,
        is_submissions_open BOOLEAN DEFAULT true
    );
`;

const insertInitialRowQuery = `
    INSERT INTO system_settings (is_submissions_open) 
    SELECT true 
    WHERE NOT EXISTS (SELECT 1 FROM system_settings);
`;

const init = async () => {
    try {
        console.log('⏳ Creating system_settings table...');
        await pool.query(createTableQuery);
        
        console.log('⏳ Inserting default toggle state...');
        await pool.query(insertInitialRowQuery);
        
        console.log('✅ system_settings table created successfully!');
    } catch (err) {
        console.error('❌ Error initializing table:', err);
    } finally {
        pool.end();
    }
};

init();