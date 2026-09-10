const nodemailer = require('nodemailer');

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
            from: '"PTE Credit Transfer" <noreply@adminisztracio.pte.hu>',
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