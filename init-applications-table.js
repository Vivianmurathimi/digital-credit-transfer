require('dotenv').config();
const pool = require('./db');

const resetApplicationsTable = async () => {
    try {
        console.log("⏳ Deleting old table and rebuilding with new 'fulfilled_course' name...");
        
        // 🧨 1. Delete the old table completely
        await pool.query('DROP TABLE IF EXISTS applications;'); 
        
        // 🏗️ 2. Build the perfect new table
        await pool.query(`
            CREATE TABLE applications (
                id SERIAL PRIMARY KEY,
                student_id INTEGER REFERENCES users(id),
                fulfilled_course VARCHAR(255) NOT NULL,    -- <--- The brand new name!
                pte_course_id INTEGER REFERENCES courses(id),
                syllabus_file VARCHAR(255) NOT NULL,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        console.log("✅ Success! The 'applications' table is perfectly rebuilt.");
    } catch (err) {
        console.error("❌ Database Error:", err);
    } finally {
        pool.end(); 
    }
};

resetApplicationsTable();