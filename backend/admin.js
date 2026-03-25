// ...existing code...
const pool = require('./db'); // Connect to your database

async function crownAdmin() {
    const adminEmail = 'tate@gmail.com'; // <--- Change this if you used a different email!

    try {
        console.log(`👑 Attempting to make ${adminEmail} a Super Admin...`);
        
        // Test connection
        await pool.query('SELECT 1');
        console.log('✅ Database connected.');

        const result = await pool.query(
            "UPDATE users SET role = 'superadmin' WHERE email = $1 RETURNING name, email, role",
            [adminEmail]
        );

        if (result.rows.length > 0) {
            console.log('✅ Success! The user is now a Super Admin:');
            console.log(result.rows);
        } else {
            console.log('❌ Error: Could not find that email in the database.');
            // Optional: List all users to verify
            const allUsers = await pool.query('SELECT email FROM users LIMIT 10');
            console.log('Sample users:', allUsers.rows);
        }

    } catch (error) {
        console.error('Database error:', error.message);
        console.error('Stack:', error.stack);
    } finally {
        pool.end(); // Close the connection
    }
}

crownAdmin();
