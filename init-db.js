const pool = require('./db');

const createTables = async () => {
    const userTableQuery = `
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            role VARCHAR(50) DEFAULT 'student',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    try {
        console.log("🔨 Building database tables...");
        await pool.query(userTableQuery);
        console.log("✅ Users table created successfully!");
    } catch (err) {
        console.error("❌ Error creating tables:", err);
    } finally {
        pool.end(); // Closes the connection when finished
    }
};

createTables();