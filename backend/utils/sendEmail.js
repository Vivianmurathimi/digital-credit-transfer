const nodemailer = require('nodemailer');

const sendEmail = async (options) => {
    // 1. Create the transporter using your Mailtrap credentials
    const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: process.env.EMAIL_PORT,
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS,
        },
    });

    // 2. Define the email options
    const mailOptions = {
        from: '"PTE Credit Transfer System" <noreply@pte.hu>', 
        to: options.email,
        subject: options.subject,
        html: options.html, 
    };

    // 3. Send the email
    await transporter.sendMail(mailOptions);
};

module.exports = sendEmail;