const pool = require('./db');

const createFirstUser = async () => {
    // The SQL command to insert data. The $1, $2 are placeholders for security!
    const insertQuery = `
        INSERT INTO users (full_name, email, password, role) 
        VALUES ($1, $2, $3, $4) 
        RETURNING *;
    `;
    
    // The actual data we are dropping into the placeholders
    const userData = ['Vivian Murathi', 'vivian@example.com', 'mypassword123', 'student'];

    try {
        console.log("📝 Adding user to the database...");
        const result = await pool.query(insertQuery, userData);
        console.log("🎉 User created successfully! Here is the data:");
        console.log(result.rows[0]); // Prints the newly created user
    } catch (err) {
        console.error("❌ Error creating user:", err);
    } finally {
        pool.end(); // Hangs up the connection
    }
};

createFirstUser();