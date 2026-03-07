const pool = require('./db');

async function buildMapping() {
    try {
        console.log("🔨 Phase 3: Creating Mapping Table...");
        
        // Use single quotes 'pending' for the default text value
        await pool.query(`
            CREATE TABLE IF NOT EXISTS transfer_mappings (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                external_course_name TEXT NOT NULL,
                external_course_credits INTEGER NOT NULL,
                target_pte_course_id INTEGER REFERENCES courses(id),
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        console.log("✅ 3. Mapping Table: OK");
    } catch (err) {
        console.error("❌ Error:", err.message);
    } finally {
        await pool.end();
    }
}

buildMapping();