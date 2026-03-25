const pool = require('./db');
const bcrypt = require('bcryptjs');

async function setupUsers() {
    try {
        console.log("🛠️ Upgrading users table...");
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'student'");
        
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash('password123', salt);

        console.log("👥 Creating Test Users...");

        // 1. Student (All values passed safely in the array)
        await pool.query(
            `INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO UPDATE SET role = $4`, 
            ['Alex Student', 'student@example.com', hashedPassword, 'student']
        );

        // 2. Reviewer
        await pool.query(
            `INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO UPDATE SET role = $4`, 
            ['Professor Smith', 'reviewer@example.com', hashedPassword, 'reviewer']
        );

        // 3. Super Admin
        await pool.query(
            `INSERT INTO users (name, email, password, role) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO UPDATE SET role = $4`, 
            ['Chief Admin', 'admin@example.com', hashedPassword, 'superadmin']
        );

        console.log("✅ All 3 Users Created Successfully!");

    } catch (err) {
        console.error("❌ Database Error:", err.message);
    } finally {
        await pool.end();
    }
}

setupUsers();