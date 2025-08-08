require('dotenv').config();
const express = require('express');
const { Pool } = require('pg'); // Changed from Client to Pool
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Database connection pool (replaces single client)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  max: 20, // maximum number of clients in the pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test connection
pool.on('connect', () => {
  console.log('✅ Connected to Neon PostgreSQL');
});

pool.on('error', (err) => {
  console.error('❌ Database error:', err);
});

// API Routes

// Get all trips (with optional pagination)
app.get('/api/trips', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;
    
    const result = await pool.query(
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

// Get all trips without pagination (for your React app)
app.get('/api/trips/all', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM trips ORDER BY departure_time');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching all trips:', error);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// Get trips by origin
app.get('/api/trips/from/:origin', async (req, res) => {
  try {
    const { origin } = req.params;
    const result = await pool.query(
      'SELECT * FROM trips WHERE LOWER(origin) = LOWER($1) ORDER BY departure_time',
      [origin]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching trips by origin:', error);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// Get trips by destination
app.get('/api/trips/to/:destination', async (req, res) => {
  try {
    const { destination } = req.params;
    const result = await pool.query(
      'SELECT * FROM trips WHERE LOWER(destination) = LOWER($1) ORDER BY departure_time',
      [destination]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching trips by destination:', error);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// Search trips by route
app.get('/api/trips/route/:from/:to', async (req, res) => {
  try {
    const { from, to } = req.params;
    const result = await pool.query(
      'SELECT * FROM trips WHERE LOWER(origin) = LOWER($1) AND LOWER(destination) = LOWER($2) ORDER BY departure_time',
      [from, to]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching trips by route:', error);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// Get trip statistics
app.get('/api/stats', async (req, res) => {
  try {
    const totalTrips = await pool.query('SELECT COUNT(*) FROM trips');
    const uniqueOrigins = await pool.query('SELECT COUNT(DISTINCT origin) FROM trips');
    const uniqueDestinations = await pool.query('SELECT COUNT(DISTINCT destination) FROM trips');
    const avgPrice = await pool.query('SELECT AVG(price_thb) FROM trips WHERE price_thb IS NOT NULL');
    
    res.json({
      totalTrips: parseInt(totalTrips.rows[0].count),
      uniqueOrigins: parseInt(uniqueOrigins.rows[0].count),
      uniqueDestinations: parseInt(uniqueDestinations.rows[0].count),
      averagePrice: parseFloat(avgPrice.rows[0].avg).toFixed(2)
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Backend server running on port ${PORT}`);
  console.log(`📊 API endpoints available:`);
  console.log(`   GET /api/trips/all - Get all trips`);
  console.log(`   GET /api/trips?limit=50&offset=0 - Get paginated trips`);
  console.log(`   GET /api/trips/from/:origin - Get trips by origin`);
  console.log(`   GET /api/trips/to/:destination - Get trips by destination`);
  console.log(`   GET /api/trips/route/:from/:to - Get trips by route`);
  console.log(`   GET /api/stats - Get database statistics`);
});

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
