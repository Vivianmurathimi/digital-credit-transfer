const pool = require('./db');
const bcrypt = require('bcryptjs');

async function setupUsers() {
    try {
        console.log("🛠️ Upgrading users table...");
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'student'");
        
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash('password123', salt);

        console.log("👥 Creating Test Users...");

        // 1. Student
        await pool.query(
            `INSERT INTO users (name, email, password, role, is_verified) VALUES ($1, $2, $3, $4, true) ON CONFLICT (email) DO UPDATE SET role = $4, is_verified = true`, 
            ['Alex Student', 'student@example.com', hashedPassword, 'student']
        );

        // 2. Reviewer
        await pool.query(
            `INSERT INTO users (name, email, password, role, is_verified) VALUES ($1, $2, $3, $4, true) ON CONFLICT (email) DO UPDATE SET role = $4, is_verified = true`, 
            ['Professor Smith', 'reviewer@example.com', hashedPassword, 'reviewer']
        );

        // 3. Super Admin
        await pool.query(
            `INSERT INTO users (name, email, password, role, is_verified) VALUES ($1, $2, $3, $4, true) ON CONFLICT (email) DO UPDATE SET role = $4, is_verified = true`, 
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