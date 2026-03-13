const pool = require('./db');

async function seed() {
    try {
        console.log("🌱 Seeding PTE...");
        const res = await pool.query("INSERT INTO universities (name, country) VALUES ('University of Pécs (PTE)', 'Hungary') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id");
        const pteId = res.rows[0].id;

        const courses = [
            ['PTE-CS101', 'Introduction to Computer Science', 6],
            ['PTE-MA201', 'Mathematics for Engineers II', 6],
            ['PTE-PROG2', 'Object-Oriented Programming', 5]
        ];

        for (const [code, name, creds] of courses) {
            await pool.query('INSERT INTO courses (university_id, course_code, course_name, credits) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [pteId, code, name, creds]);
        }
        console.log("🏛️ PTE Catalog: OK");
    } catch (err) {
        console.error("❌ Seed Error: " + err.message);
    } finally {
        await pool.end();
    }
}
seed();