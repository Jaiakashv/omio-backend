const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const { LRUCache } = require('lru-cache');

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

// LRU Cache settings
const CACHE_DURATION = 10 * 60 * 1000; 
const MAX_CACHE_ITEMS = 100; // Maximum number of items to keep in cache
const MAX_CACHE_SIZE = 50 * 1024 * 1024; // 50MB max memory usage

// Initialize LRU cache
const lruCache = new LRUCache({
  max: MAX_CACHE_ITEMS,
  maxSize: MAX_CACHE_SIZE,
  sizeCalculation: (value, key) => {
    return JSON.stringify(value).length + key.length;
  },
  ttl: CACHE_DURATION
});

// Root route
app.get('/', (req, res) => {
  res.send('API is running');
});

// Get all trips (cached with LRU)
app.get('/api/trips/all', async (req, res) => {
  const cacheKey = 'allTrips';
  
  // Try to get from cache
  const cachedTrips = lruCache.get(cacheKey);
  if (cachedTrips) {
    console.log("⚡ Serving /api/trips/all from LRU cache");
    return res.json(cachedTrips);
  }

  // Fetch from DB if not in cache
  try {
    const result = await pool.query('SELECT * FROM trips');
    const trips = result.rows;

    // Store in LRU cache
    lruCache.set(cacheKey, trips);

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
  console.log(`🔍 Fetching ${limit} trips with offset ${offset}`);

  try {
    // Try to get from cache first
    const allTrips = lruCache.get('allTrips');
    if (allTrips) {
      console.log("⚡ Serving paginated trips from LRU cache");
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
    console.log("🔄 Fetching trips from database");
    
    // First, check if the table exists
    const tableExists = await pool.query(
      "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'trips')"
    );
    
    if (!tableExists.rows[0].exists) {
      console.error('❌ Error: trips table does not exist');
      return res.status(500).json({ 
        error: 'Database error',
        details: 'The trips table does not exist',
        solution: 'Please run the database migrations to create the required tables'
      });
    }

    // Get column names to verify schema
    const columns = await pool.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'trips'"
    );
    console.log('📋 Database columns:', columns.rows);

    const query = 'SELECT * FROM trips ORDER BY id LIMIT $1 OFFSET $2';
    const countQuery = 'SELECT COUNT(*) FROM trips';

    const [result, countResult] = await Promise.all([
      pool.query(query, [limit, offset]),
      pool.query(countQuery),
    ]);

    console.log(`✅ Successfully fetched ${result.rows.length} trips`);
    
    res.json({
      data: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count, 10),
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
      },
    });
  } catch (error) {
    console.error('❌ Error fetching paginated trips:', {
      message: error.message,
      stack: error.stack,
      query: error.query,
      parameters: error.parameters
    });
    
    res.status(500).json({ 
      error: 'Failed to fetch trips',
      details: error.message,
      query: error.query,
      hint: 'Check server logs for more details'
    });
  }
});

// Get trips by origin
app.get('/api/trips/from/:origin', async (req, res) => {
  const { origin } = req.params;
  const cacheKey = `trips_from_${origin}`;

  const cachedTrips = lruCache.get(cacheKey);
  if (cachedTrips) {
    console.log("⚡ Serving trips by origin from LRU cache");
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
  const cacheKey = 'destinations';
  const cachedDestinations = lruCache.get(cacheKey);
  if (cachedDestinations) {
    console.log("⚡ Serving destinations from LRU cache");
    return res.json(cachedDestinations);
  }

  try {
    const result = await pool.query('SELECT DISTINCT destination FROM trips ORDER BY destination');
    const destinations = result.rows.map(row => row.destination);
    // Cache the results
    lruCache.set(cacheKey, destinations);
    res.json(destinations);
  } catch (error) {
    console.error('Error fetching destinations:', error);
    res.status(500).json({ error: 'Failed to fetch destinations', details: error.message });
  }
});

// Get route statistics
app.get('/api/stats/routes', async (req, res) => {
  try {
    const query = `
      SELECT 
        COUNT(DISTINCT CONCAT(origin, '|', destination)) AS "TotalRoutes",
        ROUND(AVG(price_inr)::numeric, 2) AS "MeanPriceAverage",
        MIN(price_inr) AS "LowestPrice",
        MAX(price_inr) AS "HighestPrice",
        ROUND(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_inr)::numeric, 2) AS "MedianPrice",
        ROUND(STDDEV(price_inr)::numeric, 2) AS "StandardDeviation",
        COUNT(DISTINCT operator_name) AS "NumberOfUniqueOperators",
        (
          SELECT provider
          FROM trips
          WHERE price_inr = (SELECT MIN(price_inr) FROM trips)
          LIMIT 1
        ) AS "CheapestCarrier",
        (
          SELECT STRING_AGG(DISTINCT transport_type, ', ')
          FROM (SELECT transport_type FROM trips WHERE transport_type IS NOT NULL GROUP BY transport_type) t
        ) AS "Routes"
      FROM trips;
    `;

    const result = await pool.query(query);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No route statistics found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching route statistics:', error);
    res.status(500).json({ 
      error: 'Failed to fetch route statistics', 
      details: error.message 
    });
  }
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
