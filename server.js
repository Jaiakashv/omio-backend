require('dotenv').config();
const express = require('express');
const { Pool } = require('pg'); // Change from Client to Pool
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection pool (instead of single client)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20, // maximum number of clients in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection
pool.on('connect', () => {
  console.log('✅ Connected to Neon PostgreSQL');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on idle client', err);
  process.exit(-1);
});

// Update all your routes to use pool.query instead of client.query
app.get('/api/trips', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    const result = await pool.query( // Changed from client.query
      'SELECT * FROM trips ORDER BY departure_time LIMIT $1 OFFSET $2',
      [limit, offset]
    );
    
    res.json({
      trips: result.rows,
      total: result.rowCount,
      limit,
      offset
    });
  } catch (error) {
    console.error('Error fetching trips:', error);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// Update ALL your other routes to use pool.query
app.get('/api/trips/all', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM trips ORDER BY departure_time');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching all trips:', error);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// Continue with all your other routes using pool.query...

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down server...');
  await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  await pool.end();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🚀 Backend server running on port ${PORT}`);
});
