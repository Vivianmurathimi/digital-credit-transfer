const Minio = require('minio');
require('dotenv').config(); // Grabs your passwords from the .env vault

// Create the MinIO connection using your hidden passwords
const minioClient = new Minio.Client({
    endPoint: process.env.MINIO_ENDPOINT,
    port: parseInt(process.env.MINIO_PORT, 10),
    useSSL: false, // We are running locally, so we don't need a secure SSL certificate yet
    accessKey: process.env.MINIO_ACCESS_KEY,
    secretKey: process.env.MINIO_SECRET_KEY
});

// Test the connection by asking MinIO to list all its storage buckets
minioClient.listBuckets()
    .then(() => console.log('📁 Successfully connected to MinIO Storage!'))
    .catch(err => console.error('❌ MinIO connection error:', err));

module.exports = minioClient; // Exports this cable so other files can use it