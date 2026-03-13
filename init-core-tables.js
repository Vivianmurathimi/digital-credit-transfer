const pool = require('./db');

const createCoreTables = async () => {
    // Table 1: The Transfer Applications
    const requestsTable = `
        CREATE TABLE IF NOT EXISTS transfer_requests (
            id SERIAL PRIMARY KEY,
            user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
            previous_university VARCHAR(255) NOT NULL,
            target_university VARCHAR(255) NOT NULL,
            status VARCHAR(50) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    // Table 2: The PDF Documents
    const documentsTable = `
        CREATE TABLE IF NOT EXISTS documents (
            id SERIAL PRIMARY KEY,
            request_id INTEGER REFERENCES transfer_requests(id) ON DELETE CASCADE,
            file_name VARCHAR(255) NOT NULL,
            file_url TEXT NOT NULL,
            uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    try {
        console.log("🔨 Building core tables...");
        await pool.query(requestsTable);
        console.log("✅ Transfer Requests table created!");
        
        await pool.query(documentsTable);
        console.log("✅ Documents table created!");
    } catch (err) {
        console.error("❌ Error creating tables:", err);
    } finally {
        pool.end(); // Hang up the phone
    }
};

createCoreTables();