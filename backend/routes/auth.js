const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const crypto = require('crypto'); 
const sendEmail = require('../utils/sendEmail');

// --- REGISTER ROUTE ---
router.post('/register', async (req, res) => {
    const { name, email, password } = req.body;
    
    // 🆕 YOUR ADDITION: Check if fields are missing
    if (!email || !password || !name) {
        return res.status(400).json({ error: "All fields required" });
    }

    try {
        let assignedRole = '';
        const lowerEmail = email.toLowerCase();

        // 1. Check if user already exists
        const userExists = await pool.query('SELECT * FROM users WHERE email = $1', [lowerEmail]);
        if (userExists.rows.length > 0) return res.status(400).json({ error: "Email already registered" });

        // (Note: is_verified defaults to false automatically in the database schema)

        const domain = lowerEmail.split('@')[1];

        if (lowerEmail.endsWith('@mik.pte.hu')) assignedRole = 'reviewer';
        else if (lowerEmail.endsWith('@tr.pte.hu')) assignedRole = 'student';
        else if (lowerEmail.endsWith('@admin.pte.hu')) assignedRole = 'superadmin';
        else return res.status(400).json({ error: "Invalid domain. Use @mik or @tr email." });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const verificationToken = crypto.randomBytes(32).toString('hex');

        const result = await pool.query(
            'INSERT INTO users (name, email, password, role, verification_token) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,role',
            [name, lowerEmail, hashedPassword, assignedRole, verificationToken] 
        );

        // 5. Build the verification link & send the email
        const verifyUrl = `http://localhost:3000/verify/${verificationToken}`;
        const message = `
            <h2>Welcome to the PTE Credit Transfer System!</h2>
            <p>Please click the button below to verify your official university email address and activate your account.</p>
            <a href="${verifyUrl}" style="background-color: #004085; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Verify My Account</a>
            <p>If the button doesn't work, copy and paste this link into your browser: <br/> ${verifyUrl}</p>
        `;

        await sendEmail({
            email: lowerEmail,
            subject: 'Action Required: Verify Your PTE Account',
            html: message
        });

        res.json({ success: true, message: "Registration successful! Please check your email to verify your account." });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Server error during registration" });
    }
});

// --- VERIFY ROUTE ---
router.get('/verify/:token', async (req, res) => {
    const { token } = req.params;

    try {
        const result = await pool.query(
            'UPDATE users SET is_verified = true, verification_token = NULL WHERE verification_token = $1 RETURNING *',
            [token]
        );

        if (result.rows.length === 0) {
            return res.status(400).send("Invalid or expired token");
        }

        res.send("Email verified successfully! You may now close this tab and log in.");
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Verification failed");
    }
});

// --- LOGIN ROUTE ---
router.post('/login', async (req, res) => {
    const { email, password } = req.body;

    // 🆕 Quick validation for login
    if (!email || !password) {
        return res.status(400).json({ error: "All fields required" });
    }

    try {
        const result = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase()]);
        if (result.rows.length === 0) return res.status(401).json({ error: "Invalid credentials" });

        const user = result.rows[0];
        
        // 🆕 YOUR ADDITION: Block unverified users right here!
        if (!user.is_verified) {
            return res.status(403).json({ error: "Please verify your email first. Check your inbox!" });
        }

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: "Invalid credentials" });

        const token = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET || 'secret_key',
            { expiresIn: '1h' }
        );
        
        res.json({ success: true, token, role: user.role });
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: "Login failed" });
    }
});

// --- FORGOT PASSWORD ROUTE ---
router.post('/forgot-password', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    try {
        // 1. Check if user exists
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
        if (result.rows.length === 0) {
            // Security best practice: Don't reveal if the email exists or not to prevent snooping!
            return res.json({ success: true, message: "If that email exists, a reset link has been sent." });
        }

        // 2. Generate Token & Expiration (1 hour from now)
        const resetToken = crypto.randomBytes(32).toString('hex');
        const resetExpires = Date.now() + 3600000; // 1 hour in milliseconds

        // 3. Save to database
        await pool.query(
            'UPDATE users SET reset_password_token = $1, reset_password_expires = $2 WHERE email = $3',
            [resetToken, resetExpires, email.toLowerCase()]
        );

        // 4. Send Email
        const resetUrl = `http://localhost:3000/reset-password/${resetToken}`;
        const message = `
            <h2>Password Reset Request</h2>
            <p>You requested a password reset for your PTE Credit Transfer account.</p>
            <p>Please click the button below to set a new password. This link is valid for 1 hour.</p>
            <a href="${resetUrl}" style="background-color: #dc3545; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; display: inline-block;">Reset Password</a>
            <p>If you did not request this, please ignore this email.</p>
        `;

        await sendEmail({
            email: email.toLowerCase(),
            subject: 'PTE Portal: Password Reset Request',
            html: message
        });

        res.json({ success: true, message: "If that email exists, a reset link has been sent." });

    } catch (err) {
        console.error("Forgot password error:", err.message);
        res.status(500).json({ error: "Server error" });
    }
});

// --- RESET PASSWORD ROUTE ---
router.post('/reset-password/:token', async (req, res) => {
    const { token } = req.params;
    const { newPassword } = req.body;

    if (!newPassword) return res.status(400).json({ error: "New password is required" });

    try {
        // 1. Find user by token AND ensure the token hasn't expired
        const result = await pool.query(
            'SELECT * FROM users WHERE reset_password_token = $1 AND reset_password_expires > $2',
            [token, Date.now()]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: "Password reset link is invalid or has expired." });
        }

        const user = result.rows[0];

        // 2. Hash the new password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        // 3. Update password and clear the reset tokens
        await pool.query(
            'UPDATE users SET password = $1, reset_password_token = NULL, reset_password_expires = NULL WHERE id = $2',
            [hashedPassword, user.id]
        );

        res.json({ success: true, message: "Password has been successfully reset! You may now log in." });

    } catch (err) {
        console.error("Reset password error:", err.message);
        res.status(500).json({ error: "Server error" });
    }
});
module.exports = router;