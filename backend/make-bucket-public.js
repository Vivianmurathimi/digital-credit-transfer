const Minio = require('minio');
require('dotenv').config();

const minioClient = new Minio.Client({
    endPoint: 'localhost',
    port: 9000,
    useSSL: false,
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY,
});

const bucketName = 'transcripts'; // Matching your screenshot

// This policy tells MinIO: "Let anyone READ files in this bucket"
const publicPolicy = {
    Version: "2012-10-17",
    Statement: [
        {
            Effect: "Allow",
            Principal: { AWS: ["*"] },
            Action: ["s3:GetBucketLocation", "s3:ListBucket"],
            Resource: [`arn:aws:s3:::${bucketName}`],
        },
        {
            Effect: "Allow",
            Principal: { AWS: ["*"] },
            Action: ["s3:GetObject"],
            Resource: [`arn:aws:s3:::${bucketName}/*`],
        },
    ],
};

const setPolicy = async () => {
    try {
        console.log(`⏳ Setting public policy for bucket: ${bucketName}...`);
        await minioClient.setBucketPolicy(bucketName, JSON.stringify(publicPolicy));
        console.log(`✅ Success! The '${bucketName}' bucket is now PUBLIC.`);
        console.log(`🔗 Reviewer can now see images at: http://localhost:9000/${bucketName}/filename.png`);
    } catch (err) {
        console.error("❌ Error setting policy:", err);
    }
};

setPolicy();