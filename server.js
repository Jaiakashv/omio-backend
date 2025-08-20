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
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_ITEMS = 50; // Reduced from 100 to 50
const MAX_CACHE_SIZE = 20 * 1024 * 1024; // Reduced from 50MB to 20MB

// Track cache statistics
let cacheStats = {
  hits: 0,
  misses: 0,
  evictions: 0,
  currentSize: 0,
  lastEviction: null
};

// Safe stringify function for cache keys and values
const safeStringify = (obj) => {
  try {
    return typeof obj === 'string' ? obj : JSON.stringify(obj);
  } catch (e) {
    console.error('Error stringifying cache value:', e);
    return 'error';
  }
};

// Safe size calculation
const calculateSize = (value, key) => {
  try {
    const keyStr = safeStringify(key);
    const valueStr = safeStringify(value);
    return Buffer.byteLength(valueStr) + Buffer.byteLength(keyStr);
  } catch (e) {
    console.error('Error calculating cache size:', e);
    return 0;
  }
};

// Initialize LRU cache with better memory management
const lruCache = new LRUCache({
  max: MAX_CACHE_ITEMS,
  maxSize: MAX_CACHE_SIZE,
  sizeCalculation: (value, key) => calculateSize(value, key),
  ttl: CACHE_DURATION,
  noDisposeOnSet: true,
  dispose: (key, value) => {
    cacheStats.evictions++;
    cacheStats.lastEviction = new Date().toISOString();
    const size = calculateSize(value, key);
    cacheStats.currentSize = Math.max(0, cacheStats.currentSize - size);
    console.log(`🚮 Cache evicted: ${key}, size: ${(size / 1024).toFixed(2)}KB`);
  },
  updateSizeOnAdd: true,
  updateSizeOnGet: false,
  allowStale: false
});

// Add cache statistics endpoint
app.get('/api/cache-stats', (req, res) => {
  res.json({
    ...cacheStats,
    size: (cacheStats.currentSize / (1024 * 1024)).toFixed(2) + 'MB',
    maxSize: (MAX_CACHE_SIZE / (1024 * 1024)).toFixed(2) + 'MB',
    itemCount: lruCache.size,
    maxItems: MAX_CACHE_ITEMS,
    hitRate: cacheStats.hits + cacheStats.misses > 0 
      ? ((cacheStats.hits / (cacheStats.hits + cacheStats.misses)) * 100).toFixed(2) + '%'
      : '0%'
  });
});

// Helper function to safely get from cache
function getFromCache(key) {
  try {
    const cacheKey = safeStringify(key);
    const value = lruCache.get(cacheKey);
    if (value !== undefined) {
      cacheStats.hits++;
      console.log(`✅ Cache hit: ${cacheKey}`);
    } else {
      cacheStats.misses++;
      console.log(`❌ Cache miss: ${cacheKey}`);
    }
    return value;
  } catch (error) {
    console.error('Error getting from cache:', error);
    return undefined;
  }
}

// Helper function to safely set in cache
function setInCache(key, value) {
  try {
    const cacheKey = safeStringify(key);
    const size = calculateSize(value, cacheKey);
    cacheStats.currentSize += size;
    lruCache.set(cacheKey, value);
    console.log(`💾 Cached: ${cacheKey}, size: ${(size / 1024).toFixed(2)}KB`);
  } catch (error) {
    console.error('Error setting cache:', error);
    // Force garbage collection in case of memory pressure
    if (global.gc) {
      console.log('Running garbage collection...');
      global.gc();
    }
  }
}

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

// Helper function to execute a query with error handling
async function safeQuery(query, params = []) {
  try {
    const result = await pool.query(query, params);
    return result.rows[0] || {};
  } catch (error) {
    console.error('Query error:', { query, error });
    return {};
  }
}

// Memory optimization: Force garbage collection if available
const maybeRunGC = () => {
  if (global.gc) {
    global.gc();
    console.log('Garbage collection run');
  }
};

// Get route statistics with optimized memory usage
app.get('/api/stats/routes', async (req, res) => {
  // Create a stable cache key based on query parameters
  const cacheKey = (() => {
    const params = new URLSearchParams();
    if (req.query.from) params.set('from', req.query.from);
    if (req.query.to) params.set('to', req.query.to);
    if (req.query.transportType) params.set('transportType', req.query.transportType);
    return `routeStats:${params.toString()}`;
  })();
  
  console.log(`Cache key: ${cacheKey}`);
  
  try {
    // Try to get from cache first
    const cachedResult = getFromCache(cacheKey);
    if (cachedResult) {
      res.setHeader('Cache-Status', 'HIT');
      return res.json(cachedResult);
    }
    res.setHeader('Cache-Status', 'MISS');

    // Memory optimization: Limit concurrent operations
    const getStats = async () => {
      // Run GC before starting expensive operation
      maybeRunGC();
      try {
        // Build base query parts
        const queryParams = [];
        const conditions = [];
        
        // Add filters based on query parameters
        if (req.query.from) {
          conditions.push(`origin = $${queryParams.length + 1}`);
          queryParams.push(req.query.from);
        }
        
        if (req.query.to) {
          conditions.push(`destination = $${queryParams.length + 1}`);
          queryParams.push(req.query.to);
        }
        
        if (req.query.transportType) {
          conditions.push(`transport_type = $${queryParams.length + 1}`);
          queryParams.push(req.query.transportType);
        }

        // Get basic stats using SQL aggregation
        let statsQuery = `
          SELECT 
            COUNT(DISTINCT CONCAT(origin, '|', destination)) as total_routes,
            COUNT(DISTINCT operator_name) as unique_providers,
            COUNT(DISTINCT transport_type) as transport_types_count,
            ARRAY_AGG(DISTINCT transport_type) as transport_types,
            MIN(price_inr) as min_price,
            MAX(price_inr) as max_price,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price_inr) as median_price,
            AVG(price_inr) as avg_price,
            STDDEV(price_inr) as std_dev
          FROM trips
        `;

        if (conditions.length > 0) {
          statsQuery += ' WHERE ' + conditions.join(' AND ');
        }

        // Get all cheapest operators (multiple operators might have the same minimum price)
        const cheapestOperatorQuery = `
          WITH min_price AS (
            SELECT MIN(price_inr) as min_price
            FROM trips
            ${conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''}
          )
          SELECT ARRAY_AGG(DISTINCT operator_name) as operators
          FROM trips
          WHERE price_inr = (SELECT min_price FROM min_price)
          ${conditions.length > 0 ? 'AND ' + conditions.join(' AND ') : ''}
        `;

        // Execute queries sequentially to reduce memory pressure
        const statsResult = await pool.query(statsQuery, [...queryParams]);
        maybeRunGC();
        
        const cheapestResult = await pool.query(cheapestOperatorQuery, [...queryParams]);
        maybeRunGC();

        const stats = statsResult.rows[0];
        const cheapestOperators = cheapestResult.rows[0]?.operators || [];

        // Prepare final result
        const result = {
          totalRoutes: parseInt(stats.total_routes) || 0,
          uniqueProviders: parseInt(stats.unique_providers) || 0,
          meanPrice: parseFloat(stats.avg_price || 0).toFixed(2),
          lowestPrice: parseFloat(stats.min_price || 0).toFixed(2),
          highestPrice: parseFloat(stats.max_price || 0).toFixed(2),
          medianPrice: parseFloat(stats.median_price || 0).toFixed(2),
          standardDeviation: parseFloat(stats.std_dev || 0).toFixed(2),
          cheapestCarriers: cheapestOperators,
          routes: (stats.transport_types || []).filter(Boolean).join(', ')
        };

        // Cache the result for 5 minutes with size limit
        try {
          // Stringify once for size check
          const resultStr = JSON.stringify(result);
          const resultSize = Buffer.byteLength(resultStr, 'utf8');
          
          // Only cache if result is reasonably sized (under 1MB)
          if (resultSize < 1024 * 1024) {
            setInCache(cacheKey, result);
            console.log(`Cached result (${Math.round(resultSize/1024)}KB) with key: ${cacheKey}`);
          } else {
            console.warn('Result too large to cache, skipping cache');
          }
          
          res.setHeader('Cache-Control', 'public, max-age=300');
          return result;
        } catch (err) {
          console.error('Error caching result:', err);
          // Still return the result even if caching fails
          return result;
        }
      } catch (error) {
        console.error('Error in getStats:', error);
        throw error;
      }
    };

    const result = await getStats();
    res.json(result);
  } catch (error) {
    console.error('Error in /api/stats/routes:', error);
    
    // Memory optimization: Run GC on error
    maybeRunGC();
    
    // Return a more detailed error response
    res.status(500).json({ 
      error: 'Failed to fetch route statistics',
      message: error.message,
      // Don't leak stack traces in production
      ...(process.env.NODE_ENV !== 'production' ? { stack: error.stack } : {})
    });
  }
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
});
