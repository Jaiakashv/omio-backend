const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const cache = require('memory-cache');

// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// PostgreSQL pool using DATABASE_URL from .env
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Test the database connection
pool.connect((err, client, release) => {
  if (err) {
    return console.error('Error connecting to PostgreSQL:', err);
  }
  console.log('✅ PostgreSQL connected successfully');
  release();
});

// Middleware
app.use(cors());
app.use(express.json());

// Cache duration in ms (10 minutes)
const CACHE_DURATION = 10 * 60 * 1000;

// Root route
app.get('/', (req, res) => {
  res.send('API is running');
});

// Get all trips with caching
app.get('/api/trips/all', async (req, res) => {
  const cachedData = cache.get("all_trips");

  if (cachedData) {
    console.log("Serving /api/trips/all from cache");
    return res.json(cachedData);
  }

  try {
    const result = await pool.query('SELECT * FROM trips');

    // Store in cache
    cache.put("all_trips", result.rows, CACHE_DURATION);

    console.log("Fetched /api/trips/all from DB and cached it");
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching all trips:', error);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// Get paginated trips using same cache
app.get('/api/trips', async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;

  let allTrips = cache.get("all_trips");

  try {
    // If cache is empty, fetch and store it
    if (!allTrips) {
      console.log("Cache empty, fetching trips for pagination...");
      const result = await pool.query('SELECT * FROM trips ORDER BY id');
      allTrips = result.rows;
      cache.put("all_trips", allTrips, CACHE_DURATION);
    } else {
      console.log("Serving paginated trips from cache");
    }

    const paginatedData = allTrips.slice(parseInt(offset, 10), parseInt(offset, 10) + parseInt(limit, 10));

    res.json({
      data: paginatedData,
      pagination: {
        total: allTrips.length,
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10)
      }
    });
  } catch (error) {
    console.error('Error fetching paginated trips:', error);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// Get trips by origin
app.get('/api/trips/from/:origin', async (req, res) => {
  const { origin } = req.params;

  try {
    const query = 'SELECT * FROM trips WHERE origin = $1';
    const result = await pool.query(query, [origin]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No trips found for this origin' });
    }

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching trips by origin:', error);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// Get trips by destination
app.get('/api/trips/to/:destination', async (req, res) => {
  const { destination } = req.params;

  try {
    const query = 'SELECT * FROM trips WHERE destination = $1';
    const result = await pool.query(query, [destination]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No trips found for this destination' });
    }

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching trips by destination:', error);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// Get trips by route (origin to destination)
app.get('/api/trips/route/:from/:to', async (req, res) => {
  const { from, to } = req.params;

  try {
    const query = 'SELECT * FROM trips WHERE origin = $1 AND destination = $2';
    const result = await pool.query(query, [from, to]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: `No trips found from ${from} to ${to}`
      });
    }

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching trips by route:', error);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// Get database statistics
app.get('/api/stats', async (req, res) => {
  try {
    const [
      totalTrips,
      origins,
      destinations,
      popularRoutes
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM trips'),
      pool.query('SELECT COUNT(DISTINCT origin) FROM trips'),
      pool.query('SELECT COUNT(DISTINCT destination) FROM trips'),
      pool.query(`
        SELECT origin, destination, COUNT(*) as trip_count 
        FROM trips 
        GROUP BY origin, destination 
        ORDER BY trip_count DESC 
        LIMIT 5
      `)
    ]);

    res.json({
      totalTrips: parseInt(totalTrips.rows[0].count, 10),
      uniqueOrigins: parseInt(origins.rows[0].count, 10),
      uniqueDestinations: parseInt(destinations.rows[0].count, 10),
      mostPopularRoutes: popularRoutes.rows
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Fetch all unique origins
app.get('/api/origins', async (req, res) => {
  try {
    const result = await pool.query('SELECT DISTINCT origin FROM trips ORDER BY origin ASC');
    const origins = result.rows.map(row => row.origin);
    res.json(origins);
  } catch (error) {
    console.error('Error fetching origins:', error);
    res.status(500).json({ error: 'Failed to fetch origins', details: error.message });
  }
});

// Fetch all unique destinations
app.get('/api/destinations', async (req, res) => {
  try {
    const result = await pool.query('SELECT DISTINCT destination FROM trips ORDER BY destination ASC');
    const destinations = result.rows.map(row => row.destination);
    res.json(destinations);
  } catch (error) {
    console.error('Error fetching destinations:', error);
    res.status(500).json({ error: 'Failed to fetch destinations', details: error.message });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
