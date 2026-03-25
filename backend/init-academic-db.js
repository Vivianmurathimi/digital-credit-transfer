const pool = require('./db');

async function build() {
    try {
        console.log("🔨 Creating Tables...");
        // Use standard single quotes to avoid scanner errors
        await pool.query('CREATE TABLE IF NOT EXISTS universities (id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, country TEXT)');
        await pool.query('CREATE TABLE IF NOT EXISTS courses (id SERIAL PRIMARY KEY, university_id INTEGER REFERENCES universities(id) ON DELETE CASCADE, course_code TEXT NOT NULL, course_name TEXT NOT NULL, credits INTEGER NOT NULL, UNIQUE(university_id, course_code))');
        console.log("✅ Academic Tables: OK");
    } catch (err) {
        console.error("❌ Error at position " + err.position + ": " + err.message);
    } finally {
        await pool.end();
    }
}
build();