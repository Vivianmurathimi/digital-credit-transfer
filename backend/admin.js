require('dotenv').config();
const pool = require('./db'); 

async function crownAdmin() {
    // ⚙️ Change this to the exact email you just registered!
    const adminEmail = 'tate@gmail.com'; 

    try {
        console.log(`👑 Attempting to make ${adminEmail} a verified Super Admin...`);
        
        // Test connection
        await pool.query('SELECT 1');
        console.log('✅ Database connected.');

        // 🆕 We are now updating BOTH the role and the verification status!
        const result = await pool.query(
            "UPDATE users SET role = 'superadmin', is_verified = true WHERE email = $1 RETURNING name, email, role, is_verified",
            [adminEmail]
        );

        if (result.rows.length > 0) {
            console.log('✅ Success! The user is now a fully verified Super Admin:');
            console.log(result.rows[0]);
        } else {
            console.log('❌ Error: Could not find that email in the database. Are you sure you registered it first?');
            const allUsers = await pool.query('SELECT email FROM users LIMIT 10');
            console.log('Sample users in DB:', allUsers.rows);
        }

    } catch (error) {
        console.error('Database error:', error.message);
    } finally {
        pool.end(); 
    }
}

crownAdmin();