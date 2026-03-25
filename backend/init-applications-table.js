require('dotenv').config();
const pool = require('./db');

const resetApplicationsTable = async () => {
    try {
        console.log("⏳ Deleting old table and rebuilding with Thesis-Grade schema...");
        
        // 🚨 Warning: This deletes all existing application data!
        await pool.query('DROP TABLE IF EXISTS applications CASCADE;'); 
        
        await pool.query(`
            CREATE TABLE applications (
                id SERIAL PRIMARY KEY,
                student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                
                -- Student Entry Data
                fulfilled_course VARCHAR(255) NOT NULL,
                fulfilled_course_code VARCHAR(100) NOT NULL,
                fulfilled_credits NUMERIC(5,2) NOT NULL,
                fulfilled_grade VARCHAR(50) NOT NULL,
                
                -- Target Course Reference
                pte_course_id INTEGER REFERENCES courses(id),
                
                -- Evidence (Upgraded to TEXT to allow multiple files)
                syllabus_file TEXT NOT NULL,
                
                -- Reviewer & Decision Data
                status VARCHAR(50) DEFAULT 'pending', -- 'pending', 'needs_info', 'approved', 'rejected'
                system_note TEXT,                     -- Automatched mismatch warnings
                reviewer_note TEXT,                   -- Mandatory rationale for decision
                calculated_fee INTEGER DEFAULT 0,     -- Calculated HUF fee
                is_locked BOOLEAN DEFAULT FALSE,      -- Lockout mechanism for student edits
                
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        
        console.log("✅ Success! The 'applications' table is upgraded with decision tracking.");
    } catch (err) {
        console.error("❌ Database Error:", err);
    } finally {
        pool.end(); 
    }
};

resetApplicationsTable();