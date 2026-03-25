const pool = require('./db');

async function seed() {
    try {
        console.log("🌱 Seeding PTE...");
        const res = await pool.query("INSERT INTO universities (name, country) VALUES ('University of Pécs (PTE)', 'Hungary') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id");
        const pteId = res.rows[0].id;

        const courses = [
            ['CS101', 'Introduction to Computer Science', 5],
            ['CS202', 'Data Structures and Algorithms', 6],
            ['CS305', 'Database Management Systems', 5],
            ['CS310', 'Web Engineering and Modern UI', 4],
            ['CS401', 'Software Engineering Architecture', 5],
            ['CS415', 'Artificial Intelligence', 4],
            ['CS450', 'Machine Learning & Data Mining', 6],
            ['MATH205', 'Linear Algebra for CS', 4],
            ['MATH310', 'Discrete Mathematics', 3],
            ['MGMT201', 'IT Project Management', 4],
            ['SEC300', 'Cybersecurity Fundamentals', 5],
            ['NET201', 'Computer Networks', 4]
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