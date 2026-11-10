const nodemailer = require('nodemailer');

// Sender shown in the emails: EMAIL_FROM in backend/.env. Must be an address the SMTP account may
// send from, or the mail server may reject the message. No real domain is written in the code
// (admin round Group 3): without EMAIL_FROM the reserved name "localhost" is used, which a
// testing inbox such as Mailtrap accepts but a real mail server will not.
const EMAIL_FROM = process.env.EMAIL_FROM || '"PTE Credit Transfer" <noreply@localhost>';
if (!process.env.EMAIL_FROM && process.env.NODE_ENV !== 'test') {
    console.warn('⚠️  EMAIL_FROM is not set in backend/.env: emails are sent from noreply@localhost (fine for Mailtrap, not for real mail).');
}

const sendEmail = async ({ email, subject, html }) => {
    try {
        // Use your existing Mailtrap credentials from your .env file
        const transporter = nodemailer.createTransport({
            host: process.env.EMAIL_HOST || "sandbox.smtp.mailtrap.io",
            port: process.env.EMAIL_PORT || 2525,
            auth: {
                user: process.env.EMAIL_USER,
                pass: process.env.EMAIL_PASS
            }
        });

        await transporter.sendMail({
            from: EMAIL_FROM,
            to: email,
            subject,
            html
        });
        
        console.log(`✅ Email sent to ${email}`);
    } catch (error) {
        console.error("❌ Email sending failed:", error);
    }
};

module.exports = sendEmail;