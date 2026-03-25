const pool = require('./db');

const createTables = async () => {
    const dropTableQuery = `DROP TABLE IF EXISTS users CASCADE;`;
    
    const userTableQuery = `
        CREATE TABLE users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(100) NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL,
            role VARCHAR(50) DEFAULT 'student',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    const renameColumnQuery = `
        ALTER TABLE users RENAME COLUMN username TO name;
    `;

    try {
        console.log("🔨 Building database tables...");
        await pool.query(dropTableQuery);
        console.log("✅ Table dropped");
        await pool.query(userTableQuery);
        console.log("✅ Users table created successfully!");
        
        await pool.query(renameColumnQuery);
        console.log("✅ Column renamed from username to name!");
    } catch (err) {
        console.error("❌ Error creating tables:", err);
    } finally {
        pool.end(); // Closes the connection when finished
    }
};

createTables();