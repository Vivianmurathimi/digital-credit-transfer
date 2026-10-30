const { Pool } = require('pg'); // The Postgres translator tool
require('dotenv').config(); // Grabs your passwords from the .env file

// Create the connection using your hidden passwords
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

// Test the connection, then give the connection back to the pool
// (kept open, it stopped scripts and tests from ending on their own)
pool.connect()
    .then((client) => {
        client.release();
        console.log('📦 Successfully connected to the PostgreSQL Database!');
    })
    .catch(err => console.error('❌ Database connection error:', err.stack));

module.exports = pool; // Exports this cable so other files can use it