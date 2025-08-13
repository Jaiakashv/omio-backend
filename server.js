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

// Test DB connection
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

// Cache settings
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
const tripCacheMap = new Map(); // Extra fast lookup

// Root route
app.get('/', (req, res) => {
  res.send('API is running');
});

// Get all trips (cached in Map + memory-cache)
app.get('/api/trips/all', async (req, res) => {
  // 1. Try Map first
  if (tripCacheMap.has('allTrips')) {
    console.log("⚡ Serving /api/trips/all from Map cache");
    return res.json(tripCacheMap.get('allTrips'));
  }

  // 2. Try memory-cache
  const cachedTrips = cache.get('allTrips');
  if (cachedTrips) {
    console.log("⚡ Serving /api/trips/all from memory-cache");
    tripCacheMap.set('allTrips', cachedTrips);
    return res.json(cachedTrips);
  }

  // 3. Fetch from DB
  try {
    const result = await pool.query('SELECT * FROM trips');
    const trips = result.rows;

    // Store in both caches
    cache.put('allTrips', trips, CACHE_DURATION);
    tripCacheMap.set('allTrips', trips);

    console.log("✅ Fetched /api/trips/all from DB and cached it");
    res.json(trips);
  } catch (error) {
    console.error('Error fetching all trips:', error);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// Get paginated trips (from cache if possible)
app.get('/api/trips', async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;

  // If Map has full trips, paginate from memory
  if (tripCacheMap.has('allTrips')) {
    console.log("⚡ Serving paginated trips from Map cache");
    const allTrips = tripCacheMap.get('allTrips');
    return res.json({
      data: allTrips.slice(Number(offset), Number(offset) + Number(limit)),
      pagination: {
        total: allTrips.length,
        limit: Number(limit),
        offset: Number(offset),
      },
    });
  }

  // Otherwise fetch from DB
  try {
    const query = 'SELECT * FROM trips ORDER BY id LIMIT $1 OFFSET $2';
    const countQuery = 'SELECT COUNT(*) FROM trips';

    const [result, countResult] = await Promise.all([
      pool.query(query, [limit, offset]),
      pool.query(countQuery),
    ]);

    res.json({
      data: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count, 10),
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
      },
    });
  } catch (error) {
    console.error('Error fetching paginated trips:', error);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// Get trips by origin
app.get('/api/trips/from/:origin', async (req, res) => {
  const { origin } = req.params;

  if (tripCacheMap.has('allTrips')) {
    console.log("⚡ Serving trips by origin from Map cache");
    const trips = tripCacheMap.get('allTrips').filter(t => t.origin === origin);
    return res.json(trips);
  }

  try {
    const result = await pool.query('SELECT * FROM trips WHERE origin = $1', [origin]);
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

  if (tripCacheMap.has('allTrips')) {
    console.log("⚡ Serving trips by destination from Map cache");
    const trips = tripCacheMap.get('allTrips').filter(t => t.destination === destination);
    return res.json(trips);
  }

  try {
    const result = await pool.query('SELECT * FROM trips WHERE destination = $1', [destination]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No trips found for this destination' });
    }
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching trips by destination:', error);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// Get trips by route
app.get('/api/trips/route/:from/:to', async (req, res) => {
  const { from, to } = req.params;

  if (tripCacheMap.has('allTrips')) {
    console.log("⚡ Serving trips by route from Map cache");
    const trips = tripCacheMap.get('allTrips').filter(t => t.origin === from && t.destination === to);
    return res.json(trips);
  }

  try {
    const result = await pool.query('SELECT * FROM trips WHERE origin = $1 AND destination = $2', [from, to]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: `No trips found from ${from} to ${to}` });
    }
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching trips by route:', error);
    res.status(500).json({ error: 'Failed to fetch trips' });
  }
});

// Stats
app.get('/api/stats', async (req, res) => {
  if (tripCacheMap.has('allTrips')) {
    console.log("⚡ Serving stats from Map cache");
    const trips = tripCacheMap.get('allTrips');
    const totalTrips = trips.length;
    const uniqueOrigins = new Set(trips.map(t => t.origin)).size;
    const uniqueDestinations = new Set(trips.map(t => t.destination)).size;

    // Calculate most popular routes
    const routeCount = {};
    trips.forEach(t => {
      const key = `${t.origin}-${t.destination}`;
      routeCount[key] = (routeCount[key] || 0) + 1;
    });

    const mostPopularRoutes = Object.entries(routeCount)
      .map(([route, count]) => {
        const [origin, destination] = route.split('-');
        return { origin, destination, trip_count: count };
      })
      .sort((a, b) => b.trip_count - a.trip_count)
      .slice(0, 5);

    return res.json({ totalTrips, uniqueOrigins, uniqueDestinations, mostPopularRoutes });
  }

  try {
    const [totalTrips, origins, destinations, popularRoutes] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM trips'),
      pool.query('SELECT COUNT(DISTINCT origin) FROM trips'),
      pool.query('SELECT COUNT(DISTINCT destination) FROM trips'),
      pool.query(`
        SELECT origin, destination, COUNT(*) as trip_count 
        FROM trips 
        GROUP BY origin, destination 
        ORDER BY trip_count DESC 
        LIMIT 5
      `),
    ]);

    res.json({
      totalTrips: parseInt(totalTrips.rows[0].count, 10),
      uniqueOrigins: parseInt(origins.rows[0].count, 10),
      uniqueDestinations: parseInt(destinations.rows[0].count, 10),
      mostPopularRoutes: popularRoutes.rows,
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Origins
app.get('/api/origins', async (req, res) => {
  if (tripCacheMap.has('allTrips')) {
    console.log("⚡ Serving origins from Map cache");
    const origins = [...new Set(tripCacheMap.get('allTrips').map(t => t.origin))].sort();
    return res.json(origins);
  }

  try {
    const result = await pool.query('SELECT DISTINCT origin FROM trips ORDER BY origin ASC');
    const origins = result.rows.map(row => row.origin);
    res.json(origins);
  } catch (error) {
    console.error('Error fetching origins:', error);
    res.status(500).json({ error: 'Failed to fetch origins', details: error.message });
  }
});

// Destinations
app.get('/api/destinations', async (req, res) => {
  if (tripCacheMap.has('allTrips')) {
    console.log("⚡ Serving destinations from Map cache");
    const destinations = [...new Set(tripCacheMap.get('allTrips').map(t => t.destination))].sort();
    return res.json(destinations);
  }

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
  console.log(`🚀 Server running at http://localhost:${port}`);
});
